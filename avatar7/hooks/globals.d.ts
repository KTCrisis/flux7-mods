// The engine runs a newer JavaScript than the es2023 lib the types target:
// base64 on Uint8Array is there (the engine's own docs use it).
interface Uint8ArrayConstructor {
  fromBase64(base64: string): Uint8Array<ArrayBuffer>
}
interface Uint8Array {
  toBase64(): string
}
