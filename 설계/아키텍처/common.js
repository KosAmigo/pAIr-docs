// 카드 사이 화살표. 각 그림은 window.WIRES 에 연결 목록을 넣는다.
// [from, fromSide, to, toSide, opts]   side: t | b | l | r
// opts:
//   at   : 두 끝을 같은 좌표에 맞춤 (l/r 이면 y, t/b 이면 x) → 항상 일직선
//   aat / bat : 각 끝 좌표를 따로 지정 (꺾이는 선)
//   label, num, color, dash, both(양방향)
//   lside: 라벨 위치 'r'(기본, 세로선 오른쪽) | 'l' | 't'(가로선 위, 기본) | 'b'
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const H = s => s === 'l' || s === 'r';
  function pt(el, side, at) {
    const r = el.getBoundingClientRect();
    if (side === 't') return [at != null ? at : r.left + r.width / 2, r.top];
    if (side === 'b') return [at != null ? at : r.left + r.width / 2, r.bottom];
    if (side === 'l') return [r.left, at != null ? at : r.top + r.height / 2];
    return [r.right, at != null ? at : r.top + r.height / 2];
  }
  function draw() {
    const svg = document.createElementNS(NS, 'svg');
    svg.id = 'wires';
    svg.setAttribute('width', 1800); svg.setAttribute('height', 1100);
    svg.style.zIndex = 5;
    const defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    const markers = {};
    function marker(color) {
      if (markers[color]) return markers[color];
      const id = 'm' + Object.keys(markers).length;
      const m = document.createElementNS(NS, 'marker');
      m.setAttribute('id', id); m.setAttribute('viewBox', '0 0 10 10');
      m.setAttribute('refX', '8.5'); m.setAttribute('refY', '5');
      m.setAttribute('markerWidth', '6.5'); m.setAttribute('markerHeight', '6.5');
      m.setAttribute('orient', 'auto-start-reverse');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M0,0 L10,5 L0,10 z'); p.setAttribute('fill', color);
      m.appendChild(p); defs.appendChild(m);
      return (markers[color] = id);
    }
    (window.WIRES || []).forEach(([a, as, b, bs, o]) => {
      o = o || {};
      const ea = document.getElementById(a), eb = document.getElementById(b);
      if (!ea || !eb) { console.error('wire: missing', a, b); return; }
      const [x1, y1] = pt(ea, as, o.aat != null ? o.aat : o.at);
      const [x2, y2] = pt(eb, bs, o.bat != null ? o.bat : o.at);
      let pts;
      if (H(as) && H(bs)) pts = y1 === y2 ? [[x1, y1], [x2, y2]] : [[x1, y1], [(x1 + x2) / 2, y1], [(x1 + x2) / 2, y2], [x2, y2]];
      else if (!H(as) && !H(bs)) pts = x1 === x2 ? [[x1, y1], [x2, y2]] : [[x1, y1], [x1, (y1 + y2) / 2], [x2, (y1 + y2) / 2], [x2, y2]];
      else if (H(as)) pts = [[x1, y1], [x2, y1], [x2, y2]];
      else pts = [[x1, y1], [x1, y2], [x2, y2]];

      const color = o.color || '#4B5368';
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M' + pts.map(p => p.join(',')).join(' L'));
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', 2.5); path.setAttribute('stroke-linejoin', 'round');
      if (o.dash) path.setAttribute('stroke-dasharray', '7 6');
      const mk = 'url(#' + marker(color) + ')';
      path.setAttribute('marker-end', mk);
      if (o.both) path.setAttribute('marker-start', mk);
      svg.appendChild(path);

      if (o.label || o.num) {
        // 가장 긴 구간의 가운데, 선 옆에
        let bi = 0, best = -1;
        for (let i = 0; i < pts.length - 1; i++) {
          const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
          if (d > best) { best = d; bi = i; }
        }
        const [p, q] = [pts[bi], pts[bi + 1]];
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        const vertical = p[0] === q[0];
        const l = document.createElement('div');
        l.className = 'wlabel' + (o.stack ? ' stack' : '');
        l.style.color = color;
        l.innerHTML = (o.num ? '<span class="num" style="background:' + color + '">' + o.num + '</span>' : '') + (o.label || '');
        const side = o.lside || (vertical ? 'r' : 't');
        if (side === 'r') { l.style.left = (mx + 9) + 'px'; l.style.top = my + 'px'; l.style.transform = 'translateY(-50%)'; }
        if (side === 'l') { l.style.left = (mx - 9) + 'px'; l.style.top = my + 'px'; l.style.transform = 'translate(-100%,-50%)'; }
        if (side === 't') { l.style.left = mx + 'px'; l.style.top = (my - 8) + 'px'; l.style.transform = 'translate(-50%,-100%)'; }
        if (side === 'b') { l.style.left = mx + 'px'; l.style.top = (my + 8) + 'px'; l.style.transform = 'translateX(-50%)'; }
        document.body.appendChild(l);
      }
    });
    document.body.appendChild(svg);
  }
  window.addEventListener('load', () => (document.fonts ? document.fonts.ready : Promise.resolve()).then(draw));
})();
