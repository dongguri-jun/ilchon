/// A moment in time: milliseconds since 1970-01-01 UTC. The core never reads a clock; callers pass it in.
extension type const Instant(int epochMs) {}
