/**
 * Little-endian binary writer and reader. Ported from the earlier FreeWorld protocol, with
 * 24-bit integers added for city-scale positions and a reusable writer so the world server
 * can build every snapshot in one buffer without allocating per tick.
 */
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private pos = 0;

  constructor(capacity = 256) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
  }

  get length(): number {
    return this.pos;
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  private ensure(n: number) {
    if (this.pos + n <= this.buf.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.pos + n));
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
  }

  u8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  i16(v: number) {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  i24(v: number) {
    this.ensure(3);
    const u = v & 0xffffff;
    this.view.setUint16(this.pos, u & 0xffff, true);
    this.view.setUint8(this.pos + 2, u >>> 16);
    this.pos += 3;
    return this;
  }
  u32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  f32(v: number) {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  f64(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }
  str(s: string) {
    const bytes = enc.encode(s);
    if (bytes.length > 0xffff) throw new RangeError('string too long');
    this.u16(bytes.length);
    this.ensure(bytes.length);
    new Uint8Array(this.buf, this.pos, bytes.length).set(bytes);
    this.pos += bytes.length;
    return this;
  }
  /** Appends raw bytes (e.g. one encoded message after another in a frame). */
  bytes(b: Uint8Array) {
    this.ensure(b.byteLength);
    new Uint8Array(this.buf, this.pos, b.byteLength).set(b);
    this.pos += b.byteLength;
    return this;
  }
  /** Overwrites a u16 written earlier (e.g. a count only known after the entries). */
  patchU16(at: number, v: number) {
    this.view.setUint16(at, v, true);
    return this;
  }
  /** A view of the bytes written so far. Valid only until the next write or reset. */
  peek(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.buf, 0, this.pos);
  }
  /** A copy of the bytes written so far. */
  done(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.buf.slice(0, this.pos));
  }
}

export class DecodeError extends Error {}

export class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number) {
    if (this.pos + n > this.bytes.byteLength) throw new DecodeError('truncated message');
  }

  u8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i24() {
    this.need(3);
    const u = this.view.getUint16(this.pos, true) | (this.view.getUint8(this.pos + 2) << 16);
    this.pos += 3;
    return (u << 8) >> 8;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  str(max = 0xffff) {
    const n = this.u16();
    if (n > max) throw new DecodeError('string too long');
    this.need(n);
    try {
      return dec.decode(this.bytes.subarray(this.pos, (this.pos += n)));
    } catch {
      throw new DecodeError('invalid utf-8');
    }
  }
  atEnd() {
    return this.pos >= this.bytes.byteLength;
  }
  end() {
    if (this.pos !== this.bytes.byteLength) throw new DecodeError('trailing bytes');
  }
}
