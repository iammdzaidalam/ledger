export function mean(values) {
  if (values.length === 0) throw new Error("empty");
  return values.reduce((a, b) => a + b, 0) / values.length;
}
