/** Domain events are emitted as JSON lines on stdout ({"event": ...}). */
export function emit(event, data) {
  process.stdout.write(JSON.stringify({ event, ...data }) + '\n');
}
