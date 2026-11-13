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
// - Inactive (pure pass-through) in .NET SDK processes (dotnet run/build,
//   MSBuild, the compiler server) so builds see real time; set
//   SLUICE_SHIM_ALL=1 to apply it to every process.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
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
static void (*real_srand)(unsigned);
static void (*real_srandom)(unsigned);
static void (*real_srand48)(long);

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
    char b[160];
    int l = snprintf(b, sizeof b, "[sluice-shim] %s n=%zu stream=%u tid=%ld\n", src, n, k, (long)syscall(SYS_gettid));
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
  for (int i = 0; i < argc; i++)
    if (strstr(argv[i], "/sdk/")) return 1; // MSBuild.dll, VBCSCompiler.dll, csc.dll, dotnet.dll, ...
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

__attribute__((constructor)) static void sluice_init(void) {
  int64_t v;
  if (parse_i64(getenv("SLUICE_SEED"), &v)) seed = (uint64_t)v;
  for (unsigned k = 0; k < STREAMS; k++) streams[k] = seed * 0x9e3779b97f4a7c15ULL ^ (k + 1) * 0xd1b54a32d192ed03ULL;
  int have_now = parse_i64(getenv("SLUICE_NOW_MS"), &env_now);
  const char *state = getenv("SLUICE_STATE_FILE");
  const char *all = getenv("SLUICE_SHIM_ALL");
  debug = getenv("SLUICE_SHIM_DEBUG") != NULL;
  if (!have_now && !state) return;
  if (!(all && *all == '1') && is_sdk_process()) return;
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

static int frozen_clock(clockid_t c) {
  return active && (c == CLOCK_REALTIME || c == CLOCK_REALTIME_COARSE || c == CLOCK_TAI);
}

int clock_gettime(clockid_t c, struct timespec *ts) {
  if (frozen_clock(c) && ts) {
    int64_t ms = now_ms();
    ts->tv_sec = (time_t)(ms / 1000);
    ts->tv_nsec = (long)(ms % 1000) * 1000000L;
    return 0;
  }
  if (RESOLVE(clock_gettime)) return real_clock_gettime(c, ts);
  return (int)syscall(SYS_clock_gettime, c, ts);
}

int gettimeofday(struct timeval *tv, void *tz) {
  if (active) {
    if (tv) {
      int64_t ms = now_ms();
      tv->tv_sec = (time_t)(ms / 1000);
      tv->tv_usec = (suseconds_t)(ms % 1000) * 1000;
    }
    if (tz) memset(tz, 0, 2 * sizeof(int));
    return 0;
  }
  if (RESOLVE(gettimeofday)) return real_gettimeofday(tv, tz);
  return (int)syscall(SYS_gettimeofday, tv, tz);
}

time_t time(time_t *t) {
  if (active) {
    time_t s = (time_t)(now_ms() / 1000);
    if (t) *t = s;
    return s;
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
  return real_syscall(nr, a[0], a[1], a[2], a[3], a[4], a[5]);
}

static int is_random_dev(const char *path) {
  return path && (strcmp(path, "/dev/urandom") == 0 || strcmp(path, "/dev/random") == 0);
}

static int track(int fd, const char *path) {
  if (fd >= 0 && fd < MAX_FD) {
    if (active && is_random_dev(path))
      __atomic_or_fetch(&rand_fds[fd / 8], (unsigned char)(1u << (fd % 8)), __ATOMIC_RELAXED);
    else
      __atomic_and_fetch(&rand_fds[fd / 8], (unsigned char)~(1u << (fd % 8)), __ATOMIC_RELAXED);
  }
  return fd;
}

static int tracked(int fd) {
  return fd >= 0 && fd < MAX_FD && (__atomic_load_n(&rand_fds[fd / 8], __ATOMIC_RELAXED) & (1u << (fd % 8)));
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
  if (active && tracked(fd)) {
    fill(buf, n);
    return (ssize_t)n;
  }
  if (RESOLVE(read)) return real_read(fd, buf, n);
  return syscall(SYS_read, fd, buf, n);
}

int close(int fd) {
  track(fd, NULL);
  if (RESOLVE(close)) return real_close(fd);
  return (int)syscall(SYS_close, fd);
}

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

static int sluice_RAND_bytes(unsigned char *buf, int num) {
  if (num > 0) fill(buf, (size_t)num);
  return 1;
}

#ifdef __GLIBC__
static void *(*real_dlsym)(void *, const char *);

void *dlsym(void *handle, const char *name) {
  if (!real_dlsym) {
    static const char *versions[] = {"GLIBC_2.34", "GLIBC_2.17", "GLIBC_2.2.5"};
    for (int i = 0; i < 3 && !real_dlsym; i++) real_dlsym = dlvsym(RTLD_NEXT, "dlsym", versions[i]);
    if (!real_dlsym) return NULL;
  }
  void *sym = real_dlsym(handle, name);
  if (active && sym && name && (strcmp(name, "RAND_bytes") == 0 || strcmp(name, "RAND_priv_bytes") == 0))
    return (void *)sluice_RAND_bytes;
  return sym;
}
#endif
