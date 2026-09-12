/** Format a member/lead code: prefix + zero-padded sequence (AZ0001). */
export function formatCode(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
