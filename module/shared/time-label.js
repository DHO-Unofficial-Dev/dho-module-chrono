// SPDX-License-Identifier: MPL-2.0
export function timeParts(text) {
  if (typeof text !== 'string' || !new RegExp('^(?:[0-9]+[dhms])+$').test(text)) return null;
  return Array.from(text.matchAll(new RegExp('([0-9]+)([dhms])', 'g')), match => ({ value: match[1], unit: match[2] }));
}

export function renderTimeLabel(node, text) {
  if (node.dataset.timeText === text) return;
  node.dataset.timeText = text;
  const parts = timeParts(text);
  if (!parts) { node.textContent = text; return; }
  node.replaceChildren(...parts.map(part => {
    const pair = document.createElement('span'), value = document.createElement('span'), unit = document.createElement('span');
    pair.className = 'time-part'; value.className = 'time-value'; unit.className = 'time-unit';
    value.textContent = part.value; unit.textContent = part.unit; pair.append(value, unit); return pair;
  }));
}

// 아이콘 간격은 유지하고, 한 시간 토큰조차 칸보다 길 때만 글자를 줄인다.
export function fitTimeLabel(node, width, fontSize) {
  const key = `${node.dataset.timeText}/${width}/${fontSize}`;
  if (node.dataset.timeFit === key) return;
  node.style.fontSize = `${fontSize}px`;
  const parts = [...node.querySelectorAll('.time-part')];
  const range = document.createRange();
  range.selectNodeContents(node);
  let fittedSize = fontSize;
  for (let attempt = 0; attempt < 3; attempt++) {
    const widest = parts.length ? Math.max(...parts.map(part => Math.max(part.scrollWidth, part.getBoundingClientRect().width))) : range.getBoundingClientRect().width;
    if (widest <= width) break;
    fittedSize *= Math.max(1, width - 1) / widest;
    node.style.fontSize = `${fittedSize}px`;
  }
  // 숨겨진 설정 탭에서는 실측할 수 없으므로 다음 표시 때 다시 계산한다.
  if (node.getBoundingClientRect().width > 0) node.dataset.timeFit = key;
}
