// Sluice determinism shim (dotnet mode): LD_PRELOAD library, built by Sluice
// once per arch for glibc and musl. sluice-init (PID 1) sets LD_PRELOAD for
// the service command. See ADR-0010.
//
// - Wall clock: clock_gettime(CLOCK_REALTIME*, CLOCK_TAI), gettimeofday, time,
//   timespec_get return the frozen sandbox clock, read from the state file
//   sluice-init shares (moved by POST /clock). CLOCK_MONOTONIC/BOOTTIME and
//   CPU clocks stay real, so timers, Stopwatch and timeouts keep working.
// - Randomness: getrandom, getentropy, arc4random*, syscall(SYS_getrandom) and
//   reads from /dev/urandom|/dev/random return a stream seeded from SLUICE_SEED;
//   srand/srandom/srand48 ignore their argument and use a seed derived from it.
//   A read is only seeded when fstat confirms the fd still is /dev/urandom or
//   /dev/random (char device 1:9 / 1:8); dup*/fcntl(F_DUPFD*)/close*/
//   close_range keep the fd bitmap current, and pread/readv/preadv are covered.
// - Opt-in: SLUICE_DOTNET_WORKERS=N caps managed app processes at N thread
//   pool workers, so thread-local Random.Shared is deterministic too.
// - Inactive (pure pass-through) in .NET SDK processes (argv under
//   <dotnet root>/sdk/, or a `dotnet <verb>` CLI) so builds see real time;
//   set SLUICE_SHIM_ALL=1 to apply it to every process.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/uio.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#ifndef CLOCK_TAI
#define CLOCK_TAI 11
#endif

static int active;
static volatile int64_t *shared_now;
static int64_t env_now;
static uint64_t seed;

#define MAX_FD 65536
static unsigned char rand_fds[MAX_FD / 8];

static int (*real_clock_gettime)(clockid_t, struct timespec *);
static int (*real_gettimeofday)(struct timeval *, void *);
static time_t (*real_time)(time_t *);
static int (*real_timespec_get)(struct timespec *, int);
static long (*real_syscall)(long, ...);
static int (*real_open)(const char *, int, ...);
static int (*real_open64)(const char *, int, ...);
static int (*real_openat)(int, const char *, int, ...);
static int (*real_openat64)(int, const char *, int, ...);
static int (*real___open_2)(const char *, int);
static int (*real___open64_2)(const char *, int);
static ssize_t (*real_read)(int, void *, size_t);
static int (*real_close)(int);
static ssize_t (*real_pread)(int, void *, size_t, off_t);
static ssize_t (*real_pread64)(int, void *, size_t, off_t);
static ssize_t (*real_readv)(int, const struct iovec *, int);
static ssize_t (*real_preadv)(int, const struct iovec *, int, off_t);
static ssize_t (*real_preadv64)(int, const struct iovec *, int, off_t);
static int (*real_dup)(int);
static int (*real_dup2)(int, int);
static int (*real_dup3)(int, int, int);
static int (*real_fcntl)(int, int, ...);
static int (*real_fcntl64)(int, int, ...);
static int (*real_close_range)(unsigned, unsigned, int);
static void (*real_srand)(unsigned);
static void (*real_srandom)(unsigned);
static void (*real_srand48)(long);

static void untrack(int fd);
static void copy_track(int from, int to);
static void untrack_range(unsigned first, unsigned last, int flags);

#define RESOLVE(name) (real_##name ? real_##name : (real_##name = dlsym(RTLD_NEXT, #name)))

static int64_t now_ms(void) {
  return shared_now ? __atomic_load_n(shared_now, __ATOMIC_ACQUIRE) : env_now;
}

// Randomness comes from STREAMS independent splitmix64 streams (lock-free
// atomic counters), one per (entry point, request size). Different consumers
// tend to have distinct sizes (Guid: 16 bytes, Random seeding: 32, string
// hash seed: 8, ...), so a consumer racing on another thread (e.g. a thread
// pool worker seeding its thread-local Random.Shared) does not shift the
// values every other API returns.
#define STREAMS 128
static uint64_t streams[STREAMS];

static uint64_t next64(unsigned k) {
  uint64_t z = __atomic_add_fetch(&streams[k], 0x9e3779b97f4a7c15ULL, __ATOMIC_RELAXED);
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
  z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
  return z ^ (z >> 31);
}

static int debug;

static void fill_(void *buf, size_t n, const char *src) {
  uint32_t h = 2166136261u; // FNV-1a over the entry point name and size
  for (const char *c = src; *c; c++) h = (h ^ (unsigned char)*c) * 16777619u;
  for (size_t x = n, i = 0; i < sizeof n; i++, x >>= 8) h = (h ^ (x & 0xff)) * 16777619u;
  unsigned k = h % STREAMS;
  if (debug) {
    char b[200], comm[32] = "?";
    int cfd = (int)syscall(SYS_openat, AT_FDCWD, "/proc/thread-self/comm", O_RDONLY | O_CLOEXEC);
    if (cfd >= 0) {
      ssize_t cl = syscall(SYS_read, cfd, comm, sizeof comm - 1);
      syscall(SYS_close, cfd);
      comm[cl > 0 ? cl - 1 : 0] = 0;
    }
    int l = snprintf(b, sizeof b, "[sluice-shim] %s n=%zu stream=%u tid=%ld thread=%s\n", src, n, k,
                     (long)syscall(SYS_gettid), comm);
    syscall(SYS_write, 2, b, l);
  }
  unsigned char *p = buf;
  while (n) {
    uint64_t v = next64(k);
    for (int i = 0; i < 8 && n; i++, n--) *p++ = (unsigned char)(v >> (8 * i));
  }
}
#define fill(buf, n) fill_(buf, n, __func__)

static int parse_i64(const char *s, int64_t *out) {
  if (!s || !*s) return 0;
  int neg = *s == '-';
  if (neg) s++;
  int64_t v = 0;
  for (; *s; s++) {
    if (*s < '0' || *s > '9') return 0;
    v = v * 10 + (*s - '0');
  }
  *out = neg ? -v : v;
  return 1;
}

static int starts_with(const char *s, const char *prefix) { return strncmp(s, prefix, strlen(prefix)) == 0; }

// <root>/sdk/ for the dotnet roots this process can use: the directory of the
// running dotnet host (/proc/self/exe), and $DOTNET_ROOT. Symlinks resolved.
static int sdk_prefixes(char out[2][PATH_MAX + 8]) {
  int n = 0;
  char exe[PATH_MAX];
  ssize_t l = syscall(SYS_readlinkat, AT_FDCWD, "/proc/self/exe", exe, sizeof exe - 1);
  if (l > 0) {
    exe[l] = 0;
    char *slash = strrchr(exe, '/');
    if (slash && strcmp(slash + 1, "dotnet") == 0) {
      *slash = 0;
      snprintf(out[n++], PATH_MAX + 8, "%s/sdk/", exe);
    }
  }
  const char *root = getenv("DOTNET_ROOT");
  char real[PATH_MAX];
  if (root && *root && realpath(root, real)) snprintf(out[n++], PATH_MAX + 8, "%s/sdk/", real);
  return n;
}

static int is_sdk_process(void) {
  char buf[8192];
  int fd = (int)syscall(SYS_openat, AT_FDCWD, "/proc/self/cmdline", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t n = syscall(SYS_read, fd, buf, sizeof buf - 1);
  syscall(SYS_close, fd);
  if (n <= 0) return 0;
  buf[n] = 0;
  const char *argv[64];
  int argc = 0;
  for (ssize_t i = 0; i < n && argc < 64; i += (ssize_t)strlen(buf + i) + 1) argv[argc++] = buf + i;
  // MSBuild.dll, VBCSCompiler.dll, csc.dll, dotnet.dll, ... under the real SDK dir
  char prefixes[2][PATH_MAX + 8];
  int np = sdk_prefixes(prefixes);
  for (int i = 0; i < argc; i++) {
    if (!strstr(argv[i], "/sdk/")) continue;
    char real[PATH_MAX];
    const char *p = realpath(argv[i], real) ? real : argv[i];
    for (int j = 0; j < np; j++)
      if (starts_with(p, prefixes[j]) || starts_with(argv[i], prefixes[j])) return 1;
  }
  const char *base = strrchr(argv[0], '/');
  base = base ? base + 1 : argv[0];
  if (strcmp(base, "dotnet") == 0 && argc > 1) {
    // the muxer: `dotnet App.dll` / `dotnet exec App.dll` run an app, a verb runs the SDK CLI
    const char *a = argv[1];
    size_t l = strlen(a);
    if (strcmp(a, "exec") == 0 || (l > 4 && strcmp(a + l - 4, ".dll") == 0)) return 0;
    return 1;
  }
  return 0;
}

// A managed app process: `dotnet App.dll`, `dotnet exec App.dll`, or an
// apphost (an executable with <name>.dll next to it).
static int is_managed_app(void) {
  char exe[PATH_MAX];
  ssize_t l = syscall(SYS_readlinkat, AT_FDCWD, "/proc/self/exe", exe, sizeof exe - 5);
  if (l <= 0) return 0;
  exe[l] = 0;
  const char *base = strrchr(exe, '/');
  base = base ? base + 1 : exe;
  if (strcmp(base, "dotnet") == 0) {
    char buf[4096];
    int fd = (int)syscall(SYS_openat, AT_FDCWD, "/proc/self/cmdline", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    ssize_t n = syscall(SYS_read, fd, buf, sizeof buf - 1);
    syscall(SYS_close, fd);
    if (n <= 0) return 0;
    buf[n] = 0;
    size_t a0 = strlen(buf);
    if ((ssize_t)a0 + 1 >= n) return 0;
    const char *a1 = buf + a0 + 1;
    size_t l1 = strlen(a1);
    return strcmp(a1, "exec") == 0 || (l1 > 4 && strcmp(a1 + l1 - 4, ".dll") == 0);
  }
  strcat(exe, ".dll");
  return access(exe, F_OK) == 0;
}

// Opt-in (SLUICE_DOTNET_WORKERS=N in the service env): cap the thread pool of
// managed app processes at N workers. Random.Shared (and new Random() seeding)
// is per thread; with one worker, request code always runs on the same thread,
// so its values follow from the seed and the request sequence. The runtime
// reads these variables at startup, i.e. after this constructor. Only app
// processes get the cap (an SDK/MSBuild process with one worker hangs); a
// non-app process that inherited a cap Sluice set (marker SLUICE_TP_CAP, e.g.
// `dotnet build` spawned by the app) drops it again. DOTNET_ThreadPool_*
// values the app or service set themselves are never touched.
static const char *TP_MIN = "DOTNET_ThreadPool_ForceMinWorkerThreads";
static const char *TP_MAX = "DOTNET_ThreadPool_ForceMaxWorkerThreads";

static void thread_pool_cap(int app) {
  const char *mark = getenv("SLUICE_TP_CAP");
  if (mark) {
    if (app) return; // inherited by another app process: keep
    const char *mn = getenv(TP_MIN), *mx = getenv(TP_MAX);
    if (mn && strcmp(mn, mark) == 0) unsetenv(TP_MIN);
    if (mx && strcmp(mx, mark) == 0) unsetenv(TP_MAX);
    unsetenv("SLUICE_TP_CAP");
    return;
  }
  const char *w = getenv("SLUICE_DOTNET_WORKERS");
  if (!app || !w || !*w || strcmp(w, "0") == 0) return;
  if (getenv(TP_MIN) || getenv(TP_MAX)) return;
  setenv(TP_MIN, w, 1);
  setenv(TP_MAX, w, 1);
  setenv("SLUICE_TP_CAP", w, 1);
}

__attribute__((constructor)) static void sluice_init(void) {
  int64_t v;
  if (parse_i64(getenv("SLUICE_SEED"), &v)) seed = (uint64_t)v;
  for (unsigned k = 0; k < STREAMS; k++) streams[k] = seed * 0x9e3779b97f4a7c15ULL ^ (k + 1) * 0xd1b54a32d192ed03ULL;
  int have_now = parse_i64(getenv("SLUICE_NOW_MS"), &env_now);
  const char *state = getenv("SLUICE_STATE_FILE");
  const char *all = getenv("SLUICE_SHIM_ALL");
  debug = getenv("SLUICE_SHIM_DEBUG") != NULL;
  if (!have_now && !state) return;
  int sdk = is_sdk_process();
  thread_pool_cap(!sdk && is_managed_app());
  if (!(all && *all == '1') && sdk) return;
  if (state && *state) {
    int fd = (int)syscall(SYS_openat, AT_FDCWD, state, O_RDONLY | O_CLOEXEC);
    if (fd >= 0) {
      void *p = mmap(NULL, 4096, PROT_READ, MAP_SHARED, fd, 0);
      syscall(SYS_close, fd);
      if (p != MAP_FAILED) shared_now = (volatile int64_t *)p;
    }
  }
  active = 1;
}

// ------------------------------------------------------------------ clock

// floor division, so instants before 1970 keep 0 <= sub-second part < 1s
static void split_ms(int64_t ms, int64_t *sec, int64_t *rem_ms) {
  int64_t q = ms / 1000, r = ms % 1000;
  if (r < 0) q -= 1, r += 1000;
  *sec = q;
  *rem_ms = r;
}

static int frozen_clock(clockid_t c) {
  return active && (c == CLOCK_REALTIME || c == CLOCK_REALTIME_COARSE || c == CLOCK_TAI);
}

int clock_gettime(clockid_t c, struct timespec *ts) {
  if (frozen_clock(c) && ts) {
    int64_t sec, rem;
    split_ms(now_ms(), &sec, &rem);
    ts->tv_sec = (time_t)sec;
    ts->tv_nsec = (long)rem * 1000000L;
    return 0;
  }
  if (RESOLVE(clock_gettime)) return real_clock_gettime(c, ts);
  return (int)syscall(SYS_clock_gettime, c, ts);
}

int gettimeofday(struct timeval *tv, void *tz) {
  if (active) {
    if (tv) {
      int64_t sec, rem;
      split_ms(now_ms(), &sec, &rem);
      tv->tv_sec = (time_t)sec;
      tv->tv_usec = (suseconds_t)rem * 1000;
    }
    if (tz) memset(tz, 0, 2 * sizeof(int));
    return 0;
  }
  if (RESOLVE(gettimeofday)) return real_gettimeofday(tv, tz);
  return (int)syscall(SYS_gettimeofday, tv, tz);
}

time_t time(time_t *t) {
  if (active) {
    int64_t sec, rem;
    split_ms(now_ms(), &sec, &rem);
    if (t) *t = (time_t)sec;
    return (time_t)sec;
  }
  if (RESOLVE(time)) return real_time(t);
  struct timespec ts;
  syscall(SYS_clock_gettime, CLOCK_REALTIME, &ts);
  if (t) *t = ts.tv_sec;
  return ts.tv_sec;
}

int timespec_get(struct timespec *ts, int base) {
  if (active && base == TIME_UTC) {
    clock_gettime(CLOCK_REALTIME, ts);
    return base;
  }
  return RESOLVE(timespec_get) ? real_timespec_get(ts, base) : 0;
}

// ------------------------------------------------------------------ randomness

ssize_t getrandom(void *buf, size_t n, unsigned flags) {
  if (active) {
    fill(buf, n);
    return (ssize_t)n;
  }
  return syscall(SYS_getrandom, buf, n, flags);
}

int getentropy(void *buf, size_t n) {
  if (n > 256) {
    errno = EIO;
    return -1;
  }
  if (active) {
    fill(buf, n);
    return 0;
  }
  return syscall(SYS_getrandom, buf, n, 0) == (long)n ? 0 : -1;
}

void arc4random_buf(void *buf, size_t n) {
  if (active) {
    fill(buf, n);
    return;
  }
  static void (*real)(void *, size_t);
  if (!real) real = dlsym(RTLD_NEXT, "arc4random_buf");
  if (real) {
    real(buf, n);
    return;
  }
  for (size_t got = 0; got < n;) {
    long r = syscall(SYS_getrandom, (char *)buf + got, n - got, 0);
    if (r > 0) got += (size_t)r;
  }
}

uint32_t arc4random(void) {
  uint32_t v;
  arc4random_buf(&v, sizeof v);
  return v;
}

uint32_t arc4random_uniform(uint32_t upper) {
  if (upper < 2) return 0;
  uint32_t min = -upper % upper, r;
  do r = arc4random();
  while (r < min);
  return r % upper;
}

long syscall(long nr, ...) {
  va_list ap;
  va_start(ap, nr);
  long a[6];
  for (int i = 0; i < 6; i++) a[i] = va_arg(ap, long);
  va_end(ap);
  if (nr == SYS_getrandom && active) {
    fill((void *)a[0], (size_t)a[1]);
    return a[1];
  }
  if (!RESOLVE(syscall)) {
    errno = ENOSYS;
    return -1;
  }
  long r = real_syscall(nr, a[0], a[1], a[2], a[3], a[4], a[5]);
  if (nr == SYS_close) untrack((int)a[0]);
  else if (nr == SYS_dup3 && r >= 0) copy_track((int)a[0], (int)r);
#ifdef SYS_dup2
  else if (nr == SYS_dup2 && r >= 0) copy_track((int)a[0], (int)r);
#endif
#ifdef SYS_dup
  else if (nr == SYS_dup && r >= 0) copy_track((int)a[0], (int)r);
#endif
#ifdef SYS_close_range
  else if (nr == SYS_close_range && r == 0) untrack_range((unsigned)a[0], (unsigned)a[1], (int)a[2]);
#endif
  else if (nr == SYS_fcntl && r >= 0 && (a[1] == F_DUPFD || a[1] == F_DUPFD_CLOEXEC)) copy_track((int)a[0], (int)r);
  return r;
}

static int is_random_dev(const char *path) {
  return path && (strcmp(path, "/dev/urandom") == 0 || strcmp(path, "/dev/random") == 0);
}

static void set_bit(int fd, int on) {
  if (fd < 0 || fd >= MAX_FD) return;
  unsigned char m = (unsigned char)(1u << (fd % 8));
  if (on) __atomic_or_fetch(&rand_fds[fd / 8], m, __ATOMIC_RELAXED);
  else __atomic_and_fetch(&rand_fds[fd / 8], (unsigned char)~m, __ATOMIC_RELAXED);
}

static int bit(int fd) {
  return fd >= 0 && fd < MAX_FD && (__atomic_load_n(&rand_fds[fd / 8], __ATOMIC_RELAXED) & (1u << (fd % 8)));
}

static int track(int fd, const char *path) {
  if (fd >= 0) set_bit(fd, active && is_random_dev(path));
  return fd;
}

static void untrack(int fd) { set_bit(fd, 0); }

static void copy_track(int from, int to) {
  if (to >= 0 && to != from) set_bit(to, bit(from));
}

static void untrack_range(unsigned first, unsigned last, int flags) {
#ifdef CLOSE_RANGE_CLOEXEC
  if (flags & CLOSE_RANGE_CLOEXEC) return; // only marks them close-on-exec
#else
  if (flags & 4) return;
#endif
  for (unsigned fd = first; fd <= last && fd < MAX_FD; fd++) set_bit((int)fd, 0);
}

// The bitmap is a hint (fds can change behind our back: fclose, raw
// syscalls, inherited fds); a read is seeded only if the fd really is
// /dev/random (1:8) or /dev/urandom (1:9) right now.
static int tracked(int fd) {
  if (!active || !bit(fd)) return 0;
  struct stat st;
  if (fstat(fd, &st) == 0 && S_ISCHR(st.st_mode) && major(st.st_rdev) == 1 &&
      (minor(st.st_rdev) == 8 || minor(st.st_rdev) == 9))
    return 1;
  untrack(fd);
  return 0;
}

static mode_t open_mode(int flags, va_list ap) {
#ifdef O_TMPFILE
  if ((flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE) return va_arg(ap, mode_t);
#else
  if (flags & O_CREAT) return va_arg(ap, mode_t);
#endif
  return 0;
}

#define OPEN_WRAPPER(name)                                                         \
  int name(const char *path, int flags, ...) {                                     \
    va_list ap;                                                                    \
    va_start(ap, flags);                                                           \
    mode_t mode = open_mode(flags, ap);                                            \
    va_end(ap);                                                                    \
    int fd = RESOLVE(name) ? real_##name(path, flags, mode)                        \
                           : (int)syscall(SYS_openat, AT_FDCWD, path, flags, mode); \
    return track(fd, path);                                                        \
  }
OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)

#define OPENAT_WRAPPER(name)                                                                        \
  int name(int dirfd, const char *path, int flags, ...) {                                           \
    va_list ap;                                                                                     \
    va_start(ap, flags);                                                                            \
    mode_t mode = open_mode(flags, ap);                                                             \
    va_end(ap);                                                                                     \
    int fd = RESOLVE(name) ? real_##name(dirfd, path, flags, mode)                                  \
                           : (int)syscall(SYS_openat, dirfd, path, flags, mode);                     \
    return track(fd, path);                                                                         \
  }
OPENAT_WRAPPER(openat)
OPENAT_WRAPPER(openat64)

int __open_2(const char *path, int flags) {
  int fd = RESOLVE(__open_2) ? real___open_2(path, flags) : (int)syscall(SYS_openat, AT_FDCWD, path, flags, 0);
  return track(fd, path);
}

int __open64_2(const char *path, int flags) {
  int fd = RESOLVE(__open64_2) ? real___open64_2(path, flags) : (int)syscall(SYS_openat, AT_FDCWD, path, flags, 0);
  return track(fd, path);
}

ssize_t read(int fd, void *buf, size_t n) {
  if (tracked(fd)) {
    fill(buf, n);
    return (ssize_t)n;
  }
  if (RESOLVE(read)) return real_read(fd, buf, n);
  return syscall(SYS_read, fd, buf, n);
}

#define PREAD_WRAPPER(name)                                                  \
  ssize_t name(int fd, void *buf, size_t n, off_t off) {                     \
    if (tracked(fd)) {                                                       \
      fill(buf, n);                                                          \
      return (ssize_t)n;                                                     \
    }                                                                        \
    if (RESOLVE(name)) return real_##name(fd, buf, n, off);                  \
    return syscall(SYS_pread64, fd, buf, n, off);                            \
  }
PREAD_WRAPPER(pread)
PREAD_WRAPPER(pread64)

static ssize_t fill_iov(const struct iovec *iov, int cnt) {
  ssize_t total = 0;
  for (int i = 0; i < cnt; i++) {
    fill(iov[i].iov_base, iov[i].iov_len);
    total += (ssize_t)iov[i].iov_len;
  }
  return total;
}

ssize_t readv(int fd, const struct iovec *iov, int cnt) {
  if (tracked(fd)) return fill_iov(iov, cnt);
  if (RESOLVE(readv)) return real_readv(fd, iov, cnt);
  return syscall(SYS_readv, fd, iov, cnt);
}

#define PREADV_WRAPPER(name)                                                 \
  ssize_t name(int fd, const struct iovec *iov, int cnt, off_t off) {        \
    if (tracked(fd)) return fill_iov(iov, cnt);                              \
    if (RESOLVE(name)) return real_##name(fd, iov, cnt, off);                \
    return syscall(SYS_preadv, fd, iov, cnt, off, 0);                        \
  }
PREADV_WRAPPER(preadv)
PREADV_WRAPPER(preadv64)

int close(int fd) {
  untrack(fd);
  if (RESOLVE(close)) return real_close(fd);
  return (int)syscall(SYS_close, fd);
}

int close_range(unsigned first, unsigned last, int flags) {
#ifdef SYS_close_range
  int r = RESOLVE(close_range) ? real_close_range(first, last, flags)
                               : (int)syscall(SYS_close_range, first, last, flags);
#else
  int r = RESOLVE(close_range) ? real_close_range(first, last, flags) : (errno = ENOSYS, -1);
#endif
  if (r == 0) untrack_range(first, last, flags);
  return r;
}

int dup(int fd) {
  int r = RESOLVE(dup) ? real_dup(fd) : (int)syscall(SYS_fcntl, fd, F_DUPFD, 0);
  copy_track(fd, r);
  return r;
}

int dup2(int from, int to) {
  int r = RESOLVE(dup2) ? real_dup2(from, to) : (int)syscall(SYS_dup3, from, to, 0);
  if (r >= 0) copy_track(from, r);
  return r;
}

int dup3(int from, int to, int flags) {
  int r = RESOLVE(dup3) ? real_dup3(from, to, flags) : (int)syscall(SYS_dup3, from, to, flags);
  if (r >= 0) copy_track(from, r);
  return r;
}

#define FCNTL_WRAPPER(name)                                                  \
  int name(int fd, int cmd, ...) {                                           \
    va_list ap;                                                              \
    va_start(ap, cmd);                                                       \
    long arg = va_arg(ap, long);                                             \
    va_end(ap);                                                              \
    int r = RESOLVE(name) ? real_##name(fd, cmd, arg)                        \
                          : (int)syscall(SYS_fcntl, fd, cmd, arg);           \
    if (r >= 0 && (cmd == F_DUPFD || cmd == F_DUPFD_CLOEXEC)) copy_track(fd, r); \
    return r;                                                                \
  }
FCNTL_WRAPPER(fcntl)
FCNTL_WRAPPER(fcntl64)

static unsigned derived_seed(void) {
  return (unsigned)(seed * 2654435761u + 12345u);
}

void srand(unsigned s) {
  if (RESOLVE(srand)) real_srand(active ? derived_seed() : s);
}

void srandom(unsigned s) {
  if (RESOLVE(srandom)) real_srandom(active ? derived_seed() : s);
}

void srand48(long s) {
  if (RESOLVE(srand48)) real_srand48(active ? (long)derived_seed() : s);
}

// ------------------------------------------------------------ OpenSSL RAND
// .NET's RandomNumberGenerator calls OpenSSL's RAND_bytes, which its crypto
// shim looks up with dlsym on the libcrypto handle (so it cannot be
// interposed directly). On glibc, dlsym is wrapped to hand out a seeded
// RAND_bytes. Everything else resolves through the real dlsym.

#ifdef __GLIBC__
static int sluice_RAND_bytes(unsigned char *buf, int num) {
  if (num > 0) fill(buf, (size_t)num);
  return 1;
}

static void *(*real_dlsym)(void *, const char *);

__attribute__((noinline)) static void resolve_dlsym(void) {
  static const char *versions[] = {"GLIBC_2.34", "GLIBC_2.17", "GLIBC_2.2.5"};
  for (int i = 0; i < 3 && !real_dlsym; i++) real_dlsym = dlvsym(RTLD_NEXT, "dlsym", versions[i]);
}

static int is_rand_bytes(const char *name) {
  return name && (strcmp(name, "RAND_bytes") == 0 || strcmp(name, "RAND_priv_bytes") == 0);
}

// Every lookup but RAND_bytes on an explicit handle is a tail call, so the
// real dlsym sees the original caller's return address: RTLD_NEXT /
// RTLD_DEFAULT keep their semantics for other interposers.
void *dlsym(void *handle, const char *name) {
  if (!real_dlsym) resolve_dlsym();
  if (!real_dlsym) return NULL;
  if (!active || handle == RTLD_NEXT || handle == RTLD_DEFAULT || !is_rand_bytes(name))
    return real_dlsym(handle, name);
  return real_dlsym(handle, name) ? (void *)sluice_RAND_bytes : NULL;
}
#endif
