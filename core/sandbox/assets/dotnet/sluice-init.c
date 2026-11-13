// Sluice determinism shim (dotnet mode): PID 1 of the service container,
// statically linked (musl) so it runs on any Linux image of its arch.
//
//   sluice-init <command...>
//
// - creates the shared clock state file (SLUICE_STATE_FILE) the preload maps;
// - runs <command> with LD_PRELOAD=<the preload matching the image's libc> and
//   stdout connected to a pipe it reads, forwarding every byte to the real
//   stdout and capturing domain events (JSON lines with a string "event" key);
// - serves the control protocol on SLUICE_CONTROL_PORT (same as the Node shim):
//     POST /clock {"nowMs": n}   GET /state   GET /events?since=N
//   /events first pushes a sentinel through the stdout pipe and waits for it,
//   so everything the app wrote before it responded is included;
// - forwards SIGTERM/SIGINT/SIGHUP/SIGQUIT, reaps orphans, exits with the
//   command's status.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_EVENTS 100000
#define MAX_LINE (1 << 20)

static volatile int64_t *state_now;
static int64_t seed;
static pid_t child = -1;
static int out_fd = 1;   // the real stdout
static int pipe_w = -1;  // our copy of the app's stdout (for sentinels)

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static char **events;
static size_t nevents, capevents;
static uint64_t flush_seen;

static const char SENTINEL[] = "\x1esluice-flush:";  // + 16 hex digits + "\x1e"
#define SENTINEL_LEN (sizeof SENTINEL - 1 + 16 + 1)

static void die(const char *msg) {
  fprintf(stderr, "sluice-init: %s: %s\n", msg, strerror(errno));
  exit(127);
}

static int write_all(int fd, const char *p, size_t n) {
  while (n) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    p += w;
    n -= (size_t)w;
  }
  return 0;
}

// ------------------------------------------------------------ JSON validation

typedef struct {
  const char *p, *end;
  int depth;
  int has_event;
} J;

static void ws(J *j) {
  while (j->p < j->end && (*j->p == ' ' || *j->p == '\t' || *j->p == '\r' || *j->p == '\n')) j->p++;
}
static int value(J *j);
static int string(J *j, const char **s, size_t *len) {
  if (j->p >= j->end || *j->p != '"') return 0;
  const char *start = ++j->p;
  while (j->p < j->end) {
    unsigned char c = (unsigned char)*j->p;
    if (c == '"') {
      if (s) *s = start, *len = (size_t)(j->p - start);
      j->p++;
      return 1;
    }
    if (c < 0x20) return 0;
    if (c == '\\') {
      j->p++;
      if (j->p >= j->end) return 0;
      char e = *j->p;
      if (e == 'u') {
        for (int i = 1; i <= 4; i++) {
          char h = j->p + i < j->end ? j->p[i] : 0;
          if (!((h >= '0' && h <= '9') || (h >= 'a' && h <= 'f') || (h >= 'A' && h <= 'F'))) return 0;
        }
        j->p += 4;
      } else if (!strchr("\"\\/bfnrt", e)) {
        return 0;
      }
    }
    j->p++;
  }
  return 0;
}
static int number(J *j) {
  const char *s = j->p;
  if (j->p < j->end && *j->p == '-') j->p++;
  if (j->p >= j->end) return 0;
  if (*j->p == '0') j->p++;
  else if (*j->p >= '1' && *j->p <= '9') while (j->p < j->end && *j->p >= '0' && *j->p <= '9') j->p++;
  else return 0;
  if (j->p < j->end && *j->p == '.') {
    j->p++;
    if (j->p >= j->end || *j->p < '0' || *j->p > '9') return 0;
    while (j->p < j->end && *j->p >= '0' && *j->p <= '9') j->p++;
  }
  if (j->p < j->end && (*j->p == 'e' || *j->p == 'E')) {
    j->p++;
    if (j->p < j->end && (*j->p == '+' || *j->p == '-')) j->p++;
    if (j->p >= j->end || *j->p < '0' || *j->p > '9') return 0;
    while (j->p < j->end && *j->p >= '0' && *j->p <= '9') j->p++;
  }
  return j->p > s;
}
static int lit(J *j, const char *w) {
  size_t n = strlen(w);
  if ((size_t)(j->end - j->p) < n || memcmp(j->p, w, n)) return 0;
  j->p += n;
  return 1;
}
static int value(J *j) {
  ws(j);
  if (j->p >= j->end || ++j->depth > 512) return 0;
  int ok;
  char c = *j->p;
  if (c == '{') {
    int top = j->depth == 1;
    j->p++;
    ws(j);
    if (j->p < j->end && *j->p == '}') {
      j->p++;
      ok = 1;
    } else {
      for (;;) {
        const char *k;
        size_t kl;
        ws(j);
        if (!string(j, &k, &kl)) return 0;
        ws(j);
        if (j->p >= j->end || *j->p != ':') return 0;
        j->p++;
        ws(j);
        int is_event = top && kl == 5 && memcmp(k, "event", 5) == 0;
        if (is_event && j->p < j->end && *j->p == '"') j->has_event = 1;
        else if (is_event) j->has_event = 0;
        if (!value(j)) return 0;
        ws(j);
        if (j->p < j->end && *j->p == ',') {
          j->p++;
          continue;
        }
        if (j->p < j->end && *j->p == '}') {
          j->p++;
          break;
        }
        return 0;
      }
      ok = 1;
    }
  } else if (c == '[') {
    j->p++;
    ws(j);
    if (j->p < j->end && *j->p == ']') {
      j->p++;
    } else {
      for (;;) {
        if (!value(j)) return 0;
        ws(j);
        if (j->p < j->end && *j->p == ',') {
          j->p++;
          continue;
        }
        if (j->p < j->end && *j->p == ']') {
          j->p++;
          break;
        }
        return 0;
      }
    }
    ok = 1;
  } else if (c == '"') {
    ok = string(j, NULL, NULL);
  } else if (c == 't') {
    ok = lit(j, "true");
  } else if (c == 'f') {
    ok = lit(j, "false");
  } else if (c == 'n') {
    ok = lit(j, "null");
  } else {
    ok = number(j);
  }
  j->depth--;
  return ok;
}

// An event line: a JSON object with a top-level string "event" key.
static int is_event(const char *line, size_t n) {
  J j = {line, line + n, 0, 0};
  ws(&j);
  if (j.p >= j.end || *j.p != '{') return 0;
  if (!value(&j)) return 0;
  ws(&j);
  return j.p == j.end && j.has_event;
}

static void on_line(const char *line, size_t n) {
  while (n && (line[n - 1] == '\r' || line[n - 1] == ' ' || line[n - 1] == '\t')) n--;
  while (n && (*line == ' ' || *line == '\t')) line++, n--;
  if (!n || *line != '{' || !is_event(line, n)) return;
  pthread_mutex_lock(&mu);
  if (nevents < MAX_EVENTS) {
    if (nevents == capevents) {
      capevents = capevents ? capevents * 2 : 256;
      events = realloc(events, capevents * sizeof *events);
    }
    char *e = malloc(n + 1);
    memcpy(e, line, n);
    e[n] = 0;
    events[nevents++] = e;
  }
  pthread_mutex_unlock(&mu);
}

// ------------------------------------------------------------ stdout pump

typedef struct {
  char fw[65536];
  size_t fl;
  char *line;
  size_t ll;
  int overflow;
} Pump;

static void fw_flush(Pump *s) {
  if (s->fl) write_all(out_fd, s->fw, s->fl);
  s->fl = 0;
}

static void regular(Pump *s, char c) {
  if (s->fl == sizeof s->fw) fw_flush(s);
  s->fw[s->fl++] = c;
  if (c == '\n') {
    if (!s->overflow) on_line(s->line, s->ll);
    s->ll = 0;
    s->overflow = 0;
  } else if (s->ll < MAX_LINE) {
    s->line[s->ll++] = c;
  } else {
    s->overflow = 1;
  }
}

static int hexdigit(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }

// Forwards the app's stdout to the real stdout, feeds lines to the event
// parser and strips flush sentinels (recognised even when split across reads
// or written in the middle of an app line).
static void *pump(void *arg) {
  int fd = (int)(intptr_t)arg;
  static char buf[65536];
  static Pump s;
  s.line = malloc(MAX_LINE);
  char pend[SENTINEL_LEN];
  size_t pl = 0;
  const size_t slen = sizeof SENTINEL - 1;
  for (;;) {
    ssize_t n = read(fd, buf, sizeof buf);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    for (ssize_t i = 0; i < n; i++) {
      char c = buf[i];
      if (!pl && c != SENTINEL[0]) {
        regular(&s, c);
        continue;
      }
      pend[pl++] = c;
      int ok = pl <= slen ? c == SENTINEL[pl - 1] : pl < SENTINEL_LEN ? hexdigit(c) : c == SENTINEL[0];
      if (ok && pl == SENTINEL_LEN) {
        char hex[17];
        memcpy(hex, pend + slen, 16);
        hex[16] = 0;
        uint64_t id = strtoull(hex, NULL, 16);
        pl = 0;
        pthread_mutex_lock(&mu);
        if (id > flush_seen) flush_seen = id;
        pthread_cond_broadcast(&cv);
        pthread_mutex_unlock(&mu);
      } else if (!ok) {
        // not a sentinel after all: emit what was held back, but let a
        // trailing separator start a new candidate
        size_t k = pl;
        pl = 0;
        int restart = k > 1 && pend[k - 1] == SENTINEL[0];
        for (size_t j = 0; j < (restart ? k - 1 : k); j++) regular(&s, pend[j]);
        if (restart) pend[pl++] = SENTINEL[0];
      }
    }
    fw_flush(&s);
  }
  for (size_t j = 0; j < pl; j++) regular(&s, pend[j]);
  fw_flush(&s);
  return NULL;
}

static uint64_t flush_seq;

// Wait until everything written to the app's stdout so far has been parsed.
static void flush_events(void) {
  char s[64];
  pthread_mutex_lock(&mu);
  uint64_t id = ++flush_seq;
  pthread_mutex_unlock(&mu);
  int n = snprintf(s, sizeof s, "%s%016llx\x1e", SENTINEL, (unsigned long long)id);
  if (write_all(pipe_w, s, (size_t)n) < 0) return;
  struct timespec dl;
  clock_gettime(CLOCK_REALTIME, &dl);
  dl.tv_sec += 5;
  pthread_mutex_lock(&mu);
  while (flush_seen < id)
    if (pthread_cond_timedwait(&cv, &mu, &dl) == ETIMEDOUT) break;
  pthread_mutex_unlock(&mu);
}

// ------------------------------------------------------------ control server

typedef struct {
  char *p;
  size_t len, cap;
} Buf;

static void bput(Buf *b, const char *s, size_t n) {
  if (b->len + n + 1 > b->cap) {
    while (b->len + n + 1 > b->cap) b->cap = b->cap ? b->cap * 2 : 1024;
    b->p = realloc(b->p, b->cap);
  }
  memcpy(b->p + b->len, s, n);
  b->len += n;
  b->p[b->len] = 0;
}
static void bputs(Buf *b, const char *s) { bput(b, s, strlen(s)); }

static void handle(int c) {
  struct timeval tv = {5, 0};
  setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  char req[65536];
  size_t got = 0;
  char *hdr_end = NULL;
  while (got < sizeof req - 1) {
    ssize_t n = read(c, req + got, sizeof req - 1 - got);
    if (n <= 0) return;
    got += (size_t)n;
    req[got] = 0;
    if ((hdr_end = strstr(req, "\r\n\r\n"))) break;
  }
  if (!hdr_end) return;
  size_t body_at = (size_t)(hdr_end - req) + 4;
  size_t clen = 0;
  for (char *h = strchr(req, '\n'); h && h < hdr_end; h = strchr(h + 1, '\n'))
    if (strncasecmp(h + 1, "content-length:", 15) == 0) clen = strtoul(h + 16, NULL, 10);
  while (got < body_at + clen && got < sizeof req - 1) {
    ssize_t n = read(c, req + got, sizeof req - 1 - got);
    if (n <= 0) break;
    got += (size_t)n;
    req[got] = 0;
  }
  char method[16] = {0}, target[2048] = {0};
  if (sscanf(req, "%15s %2047s", method, target) != 2) return;
  char *q = strchr(target, '?');
  if (q) *q++ = 0;
  Buf b = {0};
  char num[128];
  if (strcmp(method, "POST") == 0 && strcmp(target, "/clock") == 0) {
    const char *k = strstr(req + body_at, "\"nowMs\"");
    if (k && (k = strchr(k + 7, ':'))) {
      char *e;
      double v = strtod(k + 1, &e);
      if (e != k + 1) __atomic_store_n(state_now, (int64_t)v, __ATOMIC_RELEASE);
    }
  }
  if (strcmp(target, "/events") == 0) {
    flush_events();
    long since = 0;
    for (char *p = q; p && *p; p = strchr(p, '&') ? strchr(p, '&') + 1 : NULL)
      if (strncmp(p, "since=", 6) == 0) since = strtol(p + 6, NULL, 10);
    pthread_mutex_lock(&mu);
    if (since < 0 || (size_t)since > nevents) since = (long)nevents;
    snprintf(num, sizeof num, "{\"total\":%zu,\"events\":[", nevents);
    bputs(&b, num);
    for (size_t i = (size_t)since; i < nevents; i++) {
      if (i > (size_t)since) bputs(&b, ",");
      bputs(&b, events[i]);
    }
    pthread_mutex_unlock(&mu);
    bputs(&b, "]}");
  } else {
    pthread_mutex_lock(&mu);
    snprintf(num, sizeof num, "{\"nowMs\":%lld,\"seed\":%lld,\"events\":%zu}",
             (long long)__atomic_load_n(state_now, __ATOMIC_ACQUIRE), (long long)seed, nevents);
    pthread_mutex_unlock(&mu);
    bputs(&b, num);
  }
  char head[256];
  int hn = snprintf(head, sizeof head,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: %zu\r\n"
                    "connection: close\r\n\r\n",
                    b.len);
  write_all(c, head, (size_t)hn);
  write_all(c, b.p, b.len);
  free(b.p);
}

static void *serve(void *arg) {
  int ls = (int)(intptr_t)arg;
  for (;;) {
    int c = accept(ls, NULL, NULL);
    if (c < 0) {
      if (errno == EINTR || errno == ECONNABORTED) continue;
      usleep(10000);
      continue;
    }
    handle(c);
    shutdown(c, SHUT_WR);
    close(c);
  }
  return NULL;
}

// ------------------------------------------------------------ main

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

static int64_t env_i64(const char *k, int64_t dflt) {
  const char *v = getenv(k);
  if (!v || !*v) return dflt;
  return strtoll(v, NULL, 10);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: sluice-init <command...>\n");
    return 2;
  }
  seed = env_i64("SLUICE_SEED", 1);

  // shared clock state
  const char *dir = access("/dev/shm", W_OK) == 0 ? "/dev/shm" : "/tmp";
  char state_path[256];
  snprintf(state_path, sizeof state_path, "%s/sluice-clock-%d", dir, (int)getpid());
  int sfd = open(state_path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  if (sfd < 0) die("create clock state file");
  if (ftruncate(sfd, 4096) < 0) die("size clock state file");
  void *m = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, sfd, 0);
  if (m == MAP_FAILED) die("map clock state file");
  close(sfd);
  state_now = (volatile int64_t *)m;
  struct timeval now;
  gettimeofday(&now, NULL);
  __atomic_store_n(state_now, env_i64("SLUICE_NOW_MS", (int64_t)now.tv_sec * 1000 + now.tv_usec / 1000),
                   __ATOMIC_RELEASE);
  setenv("SLUICE_STATE_FILE", state_path, 1);

  // LD_PRELOAD for the command, by libc
  const char *pre = NULL;
  const char *musl[] = {"/lib/ld-musl-x86_64.so.1", "/lib/ld-musl-aarch64.so.1"};
  int is_musl = access(musl[0], F_OK) == 0 || access(musl[1], F_OK) == 0;
  pre = getenv(is_musl ? "SLUICE_PRELOAD_MUSL" : "SLUICE_PRELOAD_GLIBC");
  if (pre && *pre) {
    const char *old = getenv("LD_PRELOAD");
    char *v = malloc(strlen(pre) + (old ? strlen(old) : 0) + 2);
    sprintf(v, "%s%s%s", pre, old && *old ? ":" : "", old && *old ? old : "");
    setenv("LD_PRELOAD", v, 1);
  }
  unsetenv("SLUICE_PRELOAD_MUSL");
  unsetenv("SLUICE_PRELOAD_GLIBC");

  // stdout pipe
  int p[2];
  if (pipe2(p, O_CLOEXEC) < 0) die("pipe");
  out_fd = dup(1);
  if (out_fd < 0) die("dup stdout");
  fcntl(out_fd, F_SETFD, FD_CLOEXEC);
  pipe_w = p[1];

  // control server
  long port = env_i64("SLUICE_CONTROL_PORT", 0);
  int ls = -1;
  if (port > 0) {
    ls = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int one = 1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(ls, (struct sockaddr *)&a, sizeof a) < 0 || listen(ls, 64) < 0) die("listen on SLUICE_CONTROL_PORT");
  }

  sigset_t all, old;
  sigfillset(&all);
  sigprocmask(SIG_BLOCK, &all, &old);
  child = fork();
  if (child < 0) die("fork");
  if (child == 0) {
    sigprocmask(SIG_SETMASK, &old, NULL);
    dup2(p[1], 1);
    execvp(argv[1], argv + 1);
    fprintf(stderr, "sluice-init: exec %s: %s\n", argv[1], strerror(errno));
    _exit(127);
  }
  close(1);  // the real stdout lives on as out_fd
  struct sigaction sa = {0};
  sa.sa_handler = forward;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  sigaction(SIGQUIT, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);
  sigprocmask(SIG_SETMASK, &old, NULL);

  pthread_t t;
  pthread_create(&t, NULL, pump, (void *)(intptr_t)p[0]);
  if (ls >= 0) pthread_create(&t, NULL, serve, (void *)(intptr_t)ls);

  int code = 0;
  for (;;) {
    int st;
    pid_t w = waitpid(-1, &st, 0);
    if (w < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (w == child) {
      code = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
      break;
    }
  }
  flush_events();
  unlink(state_path);
  return code;
}
