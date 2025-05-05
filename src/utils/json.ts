// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bufferReviver(_: string, value: any): any {
  if (value && typeof value === 'object' && typeof value.$binary === 'string') {
    return Buffer.from(value.$binary, 'base64');
  }
  return value;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bufferReplacer(_: string, value: any): any {
  if (Buffer.isBuffer(value)) {
    return {
      $binary: value.toString('base64'),
    };
  }
  if (
    value &&
    typeof value === 'object' &&
    value?.type === 'Buffer' &&
    Array.isArray(value.data)
  ) {
    return {
      $binary: Buffer.from(value.data).toString('base64'),
    };
  }
  return value;
}
