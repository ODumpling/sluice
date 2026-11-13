// Native regression test for the dotnet determinism preload
// (assets/dotnet/sluice-preload.c). Run with LD_PRELOAD=<lib>,
// SLUICE_NOW_MS=-1500 and SLUICE_SEED=<n>. Prints "FAIL <what>" lines and
// exits 1 on a broken check; prints "seeded <hex>" (all seeded output) so the
// caller can compare runs; prints "ok" at the end. With arguments (copied to
// <root>/dotnet) it only prints "frozen 0|1" for the SDK-process detection.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/random.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

static int failed;
#define CHECK(cond, what)                     \
  do {                                        \
    if (!(cond)) {                            \
      printf("FAIL %s\n", what);              \
      failed = 1;                             \
    }                                         \
  } while (0)

static char seeded[4096];
static void record(const unsigned char *b, size_t n) {
  for (size_t i = 0; i < n; i++) snprintf(seeded + strlen(seeded), 3, "%02x", b[i]);
}
static int all_zero(const unsigned char *b, size_t n) {
  for (size_t i = 0; i < n; i++)
    if (b[i]) return 0;
  return 1;
}

// close(2) with no libc involvement at all: the preload cannot see it
static long raw_close(long fd) {
#if defined(__x86_64__)
  long r;
  __asm__ volatile("syscall" : "=a"(r) : "a"(SYS_close), "D"(fd) : "rcx", "r11", "memory");
  return r;
#elif defined(__aarch64__)
  register long x8 __asm__("x8") = SYS_close;
  register long x0 __asm__("x0") = fd;
  __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8) : "memory");
  return x0;
#else
#error unsupported arch
#endif
}

int main(int argc, char **argv) {
  unsigned char b[16];

  // SDK-detection mode (run as <root>/dotnet <arg>): report whether the clock is frozen
  if (argc > 1) {
    printf("frozen %d\n", time(NULL) < 0);
    return 0;
  }

  // clock: frozen at -1500 ms, normalized (no negative sub-second part)
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  CHECK(ts.tv_sec == -2 && ts.tv_nsec == 500000000L, "clock_gettime normalizes negative ms");
  struct timeval tv;
  gettimeofday(&tv, NULL);
  CHECK(tv.tv_sec == -2 && tv.tv_usec == 500000, "gettimeofday normalizes negative ms");
  CHECK(time(NULL) == -2, "time() floors negative ms");
  struct timespec m1, m2;
  clock_gettime(CLOCK_MONOTONIC, &m1);
  usleep(20000);
  clock_gettime(CLOCK_MONOTONIC, &m2);
  CHECK((m2.tv_sec - m1.tv_sec) * 1000000000L + (m2.tv_nsec - m1.tv_nsec) >= 10000000L, "monotonic stays real");

  // plain /dev/urandom read is seeded
  int u = open("/dev/urandom", O_RDONLY);
  CHECK(read(u, b, 16) == 16, "read urandom");
  record(b, 16);

  // dup / fcntl(F_DUPFD_CLOEXEC) copies are seeded too
  int d = dup(u);
  CHECK(read(d, b, 8) == 8, "read dup");
  record(b, 8);
  int f = fcntl(u, F_DUPFD_CLOEXEC, 100);
  CHECK(f >= 100 && read(f, b, 8) == 8, "read fcntl dup");
  record(b, 8);

  // pread / readv / preadv
  CHECK(pread(u, b, 8, 0) == 8, "pread");
  record(b, 8);
  struct iovec iov[2] = {{b, 4}, {b + 4, 4}};
  CHECK(readv(u, iov, 2) == 8, "readv");
  record(b, 8);
  CHECK(preadv(u, iov, 2, 0) == 8, "preadv");
  record(b, 8);
  CHECK(getrandom(b, 8, 0) == 8, "getrandom");
  record(b, 8);

  // dup2 of /dev/zero over a tracked fd: zeros, not seeded bytes
  int z = open("/dev/zero", O_RDONLY);
  CHECK(dup2(z, d) == d, "dup2");
  memset(b, 0xff, sizeof b);
  CHECK(read(d, b, 16) == 16 && all_zero(b, 16), "dup2 /dev/zero over urandom fd reads zeros");

  // fd reused after a close the preload never saw: fstat check passes data through
  int r = open("/dev/urandom", O_RDONLY);
  raw_close(r);
  int p[2];
  CHECK(pipe(p) == 0, "pipe");
  if (p[0] == r || p[1] == r) {
    CHECK(write(p[1], "abcdefgh", 8) == 8, "pipe write");
    memset(b, 0, sizeof b);
    CHECK(read(p[0], b, 8) == 8 && memcmp(b, "abcdefgh", 8) == 0, "pipe on reused urandom fd reads pipe data");
  } else {
    printf("FAIL pipe did not reuse fd %d (%d,%d)\n", r, p[0], p[1]);
    failed = 1;
  }

  // syscall(SYS_close) and close_range clear tracking
  int s1 = open("/dev/urandom", O_RDONLY);
  syscall(SYS_close, s1);
  int z1 = open("/dev/zero", O_RDONLY);
  memset(b, 0xff, sizeof b);
  CHECK(z1 == s1 && read(z1, b, 8) == 8 && all_zero(b, 8), "syscall(SYS_close) clears tracking");
  int c1 = open("/dev/urandom", O_RDONLY);
#ifdef SYS_close_range
  syscall(SYS_close_range, c1, c1, 0);
#else
  close(c1);
#endif
  int z2 = open("/dev/zero", O_RDONLY);
  memset(b, 0xff, sizeof b);
  CHECK(z2 == c1 && read(z2, b, 8) == 8 && all_zero(b, 8), "close_range clears tracking");

  // dlsym(RTLD_NEXT) keeps its meaning (the next object after the caller)
  void *next = dlsym(RTLD_NEXT, "clock_gettime");
  void *dflt = dlsym(RTLD_DEFAULT, "clock_gettime");
  CHECK(next && next == dflt, "dlsym(RTLD_NEXT) resolves relative to the caller");

  printf("seeded %s\n", seeded);
  if (!failed) printf("ok\n");
  return failed;
}
