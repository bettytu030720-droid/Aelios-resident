// Markdown as the resident writes it, drawn without HTML: the text is parsed into a small tree of nodes (parseMarkdown),
// and each node is made with createElement, its words with textContent (renderMarkdown). Nothing in the text is ever
// read as HTML, and a link opens only an http(s) address. The page binds it with x-markdown="…".
/* eslint-disable no-var */

var MD_SAFE_URL = /^https?:\/\/[^\s<>"'`]+$/i;
var MD_LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
var MD_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*[\w+#.-]*\s*$/;
var MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
var MD_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
var MD_QUOTE = /^\s{0,3}>/;
// Where an address ends: before spaces and quotes, and without the punctuation that closes a sentence after it.
var MD_URL_TAIL = /[).,;:!?'"，。！？；：、）」』】]+$/;

// Inline marks, earliest first; at one place the one listed first wins. `lead`: the first group is a character
// before the mark, kept as text.
var MD_INLINE = [
  { re: /`([^`\n]+)`/, make: function (m) { return { t: 'code', v: m[1] }; } },
  { re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, make: function (m) { return { t: 'a', href: m[2], c: mdInline(m[1]) }; } },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/, make: function (m) { return { t: 'strong', c: mdInline(m[1]) }; } },
  { re: /(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/, lead: true, make: function (m) { return { t: 'strong', c: mdInline(m[2]) }; } },
  { re: /~~(?=\S)([\s\S]*?\S)~~/, make: function (m) { return { t: 'del', c: mdInline(m[1]) }; } },
  { re: /(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/, lead: true, make: function (m) { return { t: 'em', c: mdInline(m[2]) }; } },
  { re: /(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/, lead: true, make: function (m) { return { t: 'em', c: mdInline(m[2]) }; } },
  { re: /https?:\/\/[^\s<>"'`]+/i, make: function (m) { var url = m[0].replace(MD_URL_TAIL, ''); return { t: 'a', href: url, c: [{ t: 'text', v: url }], used: url.length }; } }
];

function mdText(nodes, text) {
  text.split('\n').forEach(function (part, i) {
    if (i) nodes.push({ t: 'br' });
    if (part) nodes.push({ t: 'text', v: part });
  });
}

/** A line's words and marks: bold, italic, struck out, code, links. A single line break stays one. */
function mdInline(text) {
  var nodes = [];
  var rest = String(text || '');
  while (rest) {
    var best = null;
    for (var i = 0; i < MD_INLINE.length; i++) {
      var m = MD_INLINE[i].re.exec(rest);
      if (!m) continue;
      var at = m.index + (MD_INLINE[i].lead ? m[1].length : 0);
      if (!best || at < best.at) best = { at: at, m: m, rule: MD_INLINE[i] };
    }
    if (!best) { mdText(nodes, rest); break; }
    if (best.at) mdText(nodes, rest.slice(0, best.at));
    var node = best.rule.make(best.m);
    var used = node.used !== undefined ? best.at - best.m.index + node.used : best.m[0].length;
    delete node.used;
    nodes.push(node);
    rest = rest.slice(best.m.index + used);
  }
  return nodes;
}

function mdIndent(line) {
  return /^\s*/.exec(line)[0].replace(/\t/g, '    ').length;
}

function mdCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return cell.trim(); });
}

function mdTableAt(lines, i) {
  if (i + 1 >= lines.length || lines[i].indexOf('|') < 0) return false;
  var sep = mdCells(lines[i + 1]);
  return sep.length > 0 && lines[i + 1].indexOf('-') >= 0 && sep.every(function (cell) { return /^:?-{1,}:?$/.test(cell); });
}

function mdBlockAt(lines, i) {
  var line = lines[i];
  return MD_FENCE.test(line) || MD_HEADING.test(line) || MD_RULE.test(line) || MD_QUOTE.test(line) || MD_LIST_ITEM.test(line) || mdTableAt(lines, i);
}

function mdList(lines, start) {
  var first = MD_LIST_ITEM.exec(lines[start]);
  var indent = mdIndent(first[1]);
  var ordered = /\d/.test(first[2]);
  var node = { t: ordered ? 'ol' : 'ul', items: [] };
  if (ordered) node.start = parseInt(first[2], 10);
  var i = start;
  while (i < lines.length) {
    // A blank line between two items of the list does not end it.
    if (!lines[i].trim()) {
      var next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      var after = next < lines.length && MD_LIST_ITEM.exec(lines[next]);
      if (!after || mdIndent(after[1]) !== indent || /\d/.test(after[2]) !== ordered) break;
      i = next;
    }
    var m = MD_LIST_ITEM.exec(lines[i]);
    if (!m || mdIndent(m[1]) !== indent || /\d/.test(m[2]) !== ordered) break;
    var inner = indent + m[2].length + 1;
    var body = [m[3]];
    i++;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        var j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && mdIndent(lines[j]) > indent && !(MD_LIST_ITEM.test(lines[j]) && mdIndent(MD_LIST_ITEM.exec(lines[j])[1]) <= indent)) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      var sub = MD_LIST_ITEM.exec(line);
      if (sub && mdIndent(sub[1]) <= indent) break;
      if (mdIndent(line) > indent) {
        body.push(line.replace(/^\s+/, function (space) { return space.slice(Math.min(space.length, inner)); }));
        i++;
        continue;
      }
      if (mdBlockAt(lines, i)) break;
      body.push(line.trim());
      i++;
    }
    node.items.push(mdBlocks(body));
  }
  return { node: node, next: i };
}

function mdBlocks(lines) {
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (!line.trim()) { i++; continue; }
    var fence = MD_FENCE.exec(line);
    if (fence) {
      var code = [];
      var close = new RegExp('^\\s{0,3}' + fence[1].charAt(0) + '{' + fence[1].length + ',}\\s*$');
      i++;
      while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    var heading = MD_HEADING.exec(line);
    if (heading) {
      out.push({ t: heading[1].length <= 2 ? 'h3' : 'h4', c: mdInline(heading[2]) });
      i++;
      continue;
    }
    if (MD_RULE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (MD_QUOTE.test(line)) {
      var quoted = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push({ t: 'blockquote', c: mdBlocks(quoted) });
      continue;
    }
    if (mdTableAt(lines, i)) {
      var table = { t: 'table', head: mdCells(line).map(mdInline), rows: [] };
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) table.rows.push(mdCells(lines[i++]).map(mdInline));
      out.push(table);
      continue;
    }
    if (MD_LIST_ITEM.test(line)) {
      var list = mdList(lines, i);
      out.push(list.node);
      i = list.next;
      continue;
    }
    var para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !mdBlockAt(lines, i)) para.push(lines[i++].trim());
    out.push({ t: 'p', c: mdInline(para.join('\n')) });
  }
  return out;
}

/** Markdown as a tree of plain nodes: what renderMarkdown draws, and what tests read. */
function parseMarkdown(text) {
  return mdBlocks(String(text || '').replace(/\r\n?/g, '\n').split('\n'));
}

/** The words of some Markdown without its marks, on one line: for a preview. */
function markdownPlain(text) {
  var words = [];
  var walk = function (nodes) {
    nodes.forEach(function (node) {
      if (node.v !== undefined) words.push(node.v);
      if (node.t === 'br') words.push(' ');
      if (node.c) walk(node.c);
      if (node.items) node.items.forEach(function (item) { walk(item); words.push(' '); });
      if (node.head) [node.head].concat(node.rows).forEach(function (row) { row.forEach(function (cell) { walk(cell); words.push(' '); }); });
      if (/^(p|h3|h4|pre|blockquote)$/.test(node.t)) words.push(' ');
    });
  };
  walk(parseMarkdown(text));
  return words.join('').replace(/\s+/g, ' ').trim();
}

var MD_TAGS = { p: 'p', h3: 'h3', h4: 'h4', strong: 'strong', em: 'em', del: 'del', blockquote: 'blockquote', code: 'code', hr: 'hr', br: 'br' };

function mdAppend(doc, parent, nodes) {
  nodes.forEach(function (node) {
    var el;
    if (node.t === 'text') {
      parent.appendChild(doc.createTextNode(node.v));
      return;
    }
    if (node.t === 'a') {
      el = doc.createElement('a');
      if (MD_SAFE_URL.test(node.href)) {
        el.setAttribute('href', node.href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      mdAppend(doc, el, node.c);
    } else if (node.t === 'pre') {
      el = doc.createElement('pre');
      var code = doc.createElement('code');
      code.textContent = node.v;
      el.appendChild(code);
    } else if (node.t === 'ul' || node.t === 'ol') {
      el = doc.createElement(node.t);
      if (node.t === 'ol' && node.start !== 1) el.setAttribute('start', String(node.start));
      node.items.forEach(function (item) {
        var li = doc.createElement('li');
        mdAppend(doc, li, item);
        el.appendChild(li);
      });
    } else if (node.t === 'table') {
      el = doc.createElement('div');
      el.className = 'md-table';
      var table = doc.createElement('table');
      var row = function (cells, tag) {
        var tr = doc.createElement('tr');
        cells.forEach(function (cell) {
          var td = doc.createElement(tag);
          mdAppend(doc, td, cell);
          tr.appendChild(td);
        });
        return tr;
      };
      var thead = doc.createElement('thead');
      thead.appendChild(row(node.head, 'th'));
      table.appendChild(thead);
      var tbody = doc.createElement('tbody');
      node.rows.forEach(function (cells) { tbody.appendChild(row(cells, 'td')); });
      table.appendChild(tbody);
      el.appendChild(table);
    } else {
      el = doc.createElement(MD_TAGS[node.t] || 'span');
      if (node.v !== undefined) el.textContent = node.v;
      if (node.c) mdAppend(doc, el, node.c);
    }
    parent.appendChild(el);
  });
}

/** Draws some Markdown into an element, in place of what was there. */
function renderMarkdown(el, text) {
  while (el.firstChild) el.removeChild(el.firstChild);
  mdAppend(el.ownerDocument, el, parseMarkdown(text));
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('alpine:init', function () {
    window.Alpine.directive('markdown', function (el, binding, utils) {
      var read = utils.evaluateLater(binding.expression);
      utils.effect(function () { read(function (value) { renderMarkdown(el, value); }); });
    });
  });
}
