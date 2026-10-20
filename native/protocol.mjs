export function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
export function decoder(receive) {
  let pending = Buffer.alloc(0);
  return chunk => {
    if (pending.length + chunk.length > 65536) throw new Error('Frame too large');
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUInt32LE();
      if (!size || size > 32768) throw new Error('Invalid frame size');
      if (pending.length < size + 4) return;
      const message = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(pending.subarray(4, size + 4)));
      pending = pending.subarray(size + 4);
      receive(message);
    }
  };
}
