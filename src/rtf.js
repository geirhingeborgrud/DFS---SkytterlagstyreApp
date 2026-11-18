'use strict';
/**
 * Minimal RTF-generator. RTF åpnes og redigeres direkte i Word, LibreOffice og Pages,
 * og egner seg derfor godt som «utkast til hoveddokument».
 *
 * blocks: [{ h1 }, { h2 }, { p }, { li }, { sign: ['Navn', …] }]
 */
function esc(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\line ';
    else if (code < 128) out += ch;
    else if (code < 0x10000) out += `\\u${code > 32767 ? code - 65536 : code}?`;
    else {
      // utenfor BMP: skriv som surrogatpar
      const hi = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const lo = ((code - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    }
  }
  return out;
}

function toRtf(blocks) {
  const body = blocks.map((b) => {
    if (b.h1) return `{\\pard\\sb240\\sa240\\b\\fs40 ${esc(b.h1)}\\par}`;
    if (b.h2) return `{\\pard\\sb240\\sa120\\b\\fs28 ${esc(b.h2)}\\par}`;
    if (b.li) return `{\\pard\\fi-280\\li560\\sa60 \\bullet\\tab ${esc(b.li)}\\par}`;
    if (b.note) return `{\\pard\\sa120\\i\\cf2 ${esc(b.note)}\\par}`;
    if (b.sign) {
      return b.sign.map((n) => `{\\pard\\sb480\\sa0 ______________________________\\par}{\\pard\\sa120 ${esc(n)}\\par}`).join('\n');
    }
    return `{\\pard\\sa120 ${esc(b.p || '')}\\par}`;
  }).join('\n');
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1
{\\fonttbl{\\f0\\fswiss Calibri;}}
{\\colortbl;\\red0\\green0\\blue0;\\red120\\green120\\blue120;}
\\paperw11906\\paperh16838\\margl1418\\margr1418\\margt1418\\margb1418
\\f0\\fs24
${body}
}`;
}

module.exports = { toRtf, esc };
