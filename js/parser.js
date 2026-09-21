let uidSeq = 0;
export function newId() { uidSeq += 1; return 'n' + uidSeq; }

export function parseBookmarkHTML(html) {
  uidSeq = 0;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = { id: newId(), type: 'folder', title: 'Root', attrs: {}, children: [] };
  const dl = doc.querySelector('dl');
  if (dl) walkDL(dl, root);
  return root;
}

function walkDL(dl, folder) {
  let lastFolder = folder;
  for (const child of dl.children) {
    if (child.tagName === 'P') continue;
    if (child.tagName === 'DL') {
      // 某些导出格式中 DL 与 DT 是兄弟节点,挂到最近创建的文件夹下
      if (lastFolder && lastFolder !== folder) walkDL(child, lastFolder);
      continue;
    }
    if (child.tagName !== 'DT') continue;
    let sub = null;
    for (const c of child.children) {
      if (c.tagName === 'H3') {
        const f = { id: newId(), type: 'folder', title: c.textContent.trim(), attrs: collectAttrs(c), children: [] };
        folder.children.push(f);
        lastFolder = f;
      } else if (c.tagName === 'A') {
        folder.children.push({
          id: newId(), type: 'bookmark',
          title: c.textContent.trim(),
          url: c.getAttribute('href') || '',
          attrs: collectAttrs(c)
        });
        lastFolder = null;
      } else if (c.tagName === 'DL' && lastFolder) {
        sub = c;
      }
    }
    if (sub) walkDL(sub, lastFolder);
  }
}

function collectAttrs(el) {
  const o = {};
  for (const at of el.attributes) {
    const k = at.name.toLowerCase();
    if (k === 'href') continue;
    o[k] = at.value;
  }
  return o;
}

export function serializeBookmarkHTML(root) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ];
  for (const child of root.children || []) emitNode(child, 1, lines);
  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}

function emitNode(node, depth, lines) {
  const pad = '    '.repeat(depth);
  if (node.type === 'folder') {
    lines.push(pad + '<DT>' + buildTag('H3', node.attrs, node.title) + '</H3>');
    lines.push(pad + '<DL><p>');
    for (const c of node.children || []) emitNode(c, depth + 1, lines);
    lines.push(pad + '</DL><p>');
  } else {
    const attrs = { href: node.url };
    for (const [k, v] of Object.entries(node.attrs || {})) if (k !== 'href') attrs[k] = v;
    lines.push(pad + '<DT>' + buildTag('A', attrs, node.title) + '</A>');
  }
}

function buildTag(name, attrs, text) {
  let s = '<' + name;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === '') continue;
    s += ' ' + k.toUpperCase() + '="' + escAttr(v) + '"';
  }
  return s + '>' + escText(text);
}

function escAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escText(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
