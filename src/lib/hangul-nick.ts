/** 한글 음절(가~힣, U+AC00–U+D7A3)만 허용 */
const HANGUL_SYLLABLES_ONLY = /^[\uAC00-\uD7A3]+$/;

/**
 * 트림한 닉네임이 한글 음절 **2글자**로만 이루어졌는지
 * (숫자·영문·공백·3글자 이상·자모 전용 등은 제외)
 */
export function isHangulTwoSyllableNickname(name: string): boolean {
  const t = name.trim();
  if (t.length !== 2) return false;
  return HANGUL_SYLLABLES_ONLY.test(t);
}
