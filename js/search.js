export function flatten(tree) {
  const out = [];
  (function walk(node, path) {
    const p = path ? path + ' / ' + node.title : node.title;
    if (node.type === 'bookmark') {
      out.push({
        node,
        path: p,
        titleHay: node.title.toLowerCase(),
        restHay: (p + '\n' + (node.url || '')).toLowerCase()
      });
    }
    if (node.children) node.children.forEach(c => walk(c, p));
  })(tree, '');
  return out;
}

export function flattenFolders(tree) {
  const out = [];
  (function walk(node, path, depth) {
    if (node.type !== 'folder') return;
    // depth 0 是根节点:标题不进入子项路径(与 pathOf 一致,如 "工作 / 资料" 而非 "Root / 工作 / 资料")
    const p = depth === 0 ? '' : (path ? path + ' / ' + node.title : node.title);
    if (depth > 0) out.push({ node, path, depth });
    if (node.children) node.children.forEach(c => walk(c, p, depth + 1));
  })(tree, '', 0);
  return out;
}

// 多关键字(空格分隔,AND),每个关键字做模糊子序列匹配并打分
export function searchBookmarks(flat, query) {
  const kws = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!kws.length) return [];
  const results = [];
  outer:
  for (const item of flat) {
    let total = 0;
    for (const kw of kws) {
      // 快速路径:子串命中(标题 > 路径/URL),只有未命中才走模糊子序列匹配
      const ti = item.titleHay.indexOf(kw);
      if (ti >= 0) { total += 2000 - Math.min(ti, 1000); continue; }
      const ri = item.restHay.indexOf(kw);
      if (ri >= 0) { total += 1000 - Math.min(ri, 500); continue; }
      const s = fuzzyScore(item.titleHay, kw) * 2 + fuzzyScore(item.restHay, kw);
      if (s < 0) continue outer;
      total += s;
    }
    results.push({ node: item.node, path: item.path, score: total });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// 子序列匹配:字符按顺序出现即可;连续命中、命中位置越靠前得分越高
function fuzzyScore(hay, kw) {
  const need = kw.length, have = hay.length;
  let ki = 0, score = 0, last = -2, consec = 0;
  for (let i = 0; i < have && ki < need; i++) {
    if (need - ki > have - i) return -1; // 剩余字符不够,提前剪枝
    if (hay[i] === kw[ki]) {
      consec = (i === last + 1) ? consec + 1 : 0;
      score += 10 + consec * 5 - Math.min(i - last - 1, 10);
      last = i;
      ki++;
    }
  }
  return ki === need ? score : -1;
}
