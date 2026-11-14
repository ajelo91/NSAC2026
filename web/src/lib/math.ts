export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, d = 1) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
