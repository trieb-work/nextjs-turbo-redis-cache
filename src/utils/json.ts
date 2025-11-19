// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bufferAndMapReviver(_: string, value: any): any {
  if (value && typeof value === 'object' && typeof value.$binary === 'string') {
    return Buffer.from(value.$binary, 'base64');
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof value.$map === 'object' &&
    !!value.$map
  ) {
    return new Map(
      Object.entries(value.$map).map(([key, value]) => {
        const revivedValue = bufferAndMapReviver('', value);
        return [key, revivedValue];
      }),
    );
  }
  return value;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bufferAndMapReplacer(_: string, value: any): any {
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
  if (value && typeof value === 'object' && value instanceof Map) {
    return {
      $map: Object.fromEntries(
        Array.from(value.entries()).map(([key, value]) => {
          const replacedValue = bufferAndMapReplacer('', value);
          return [key, replacedValue];
        }),
      ),
    };
  }
  return value;
}
