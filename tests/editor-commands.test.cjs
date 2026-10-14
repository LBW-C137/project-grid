const { test } = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../src/features/files/editor-commands.ts');
const { editorSyntax, indentUnit, commandFor } = commands;

// "|" marks the caret, "«" and "»" a selection.
function parse(marked) {
  const caret = marked.indexOf('|');
  if (caret !== -1) return { text: marked.replace('|', ''), start: caret, end: caret };
  const start = marked.indexOf('«'), end = marked.indexOf('»') - 1;
  return { text: marked.replace('«', '').replace('»', ''), start, end };
}
function show(state) {
  if (!state) return null;
  const { text, start, end } = state;
  return start === end ? text.slice(0, start) + '|' + text.slice(start) : text.slice(0, start) + '«' + text.slice(start, end) + '»' + text.slice(end);
}
const run = (command, marked, path = 'demo.js') => show(command(parse(marked), editorSyntax(path)));
const key = (key, code, modifiers = {}) => commandFor({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });

test('each kind of file comments its own way, configuration files with "#" by default', () => {
  const line = path => editorSyntax(path).line ?? null;
  assert.deepEqual(['src/app.ts', 'tsconfig.json', 'C:\\work\\main.go'].map(line), ['//', '//', '//']);
  assert.deepEqual(['config.yaml', 'pyproject.toml', '.env', '.env.local', 'Dockerfile', 'Makefile', '.gitignore', 'nginx.conf', 'notes.txt'].map(line), Array(9).fill('#'));
  assert.deepEqual(['setup.ini', 'query.sql', 'run.bat', 'index.html', 'site.css'].map(line), [';', '--', 'REM', null, null]);
  assert.deepEqual(editorSyntax('page.html').block, ['<!--', '-->']);
});

test('Ctrl+/ comments every selected line at their smallest indentation, past blank lines', () => {
  assert.equal(run(commands.toggleLineComment, 'if (a) {\n  «call();\n\n    other();»\n}'), 'if (a) {\n  «// call();\n\n  //   other();»\n}');
  assert.equal(run(commands.toggleLineComment, 'one|\ntwo'), '// one|\ntwo', 'the caret line alone, the caret staying with its text');
  assert.equal(run(commands.toggleLineComment, '|'), '// |', 'an empty line gets the comment');
  assert.equal(run(commands.toggleLineComment, '«one\ntwo\n»three'), '«// one\n// two\n»three', 'a selection ending at a line start leaves that line out');
});

test('Ctrl+/ uncomments when every line is commented, and comments them all when some are not', () => {
  assert.equal(run(commands.toggleLineComment, '«// one\n  //two\n// three»'), '«one\n  two\nthree»');
  assert.equal(run(commands.toggleLineComment, '«// one\ntwo»'), '«// // one\n// two»');
  assert.equal(run(commands.toggleLineComment, '«key: 1\nother: 2»', 'config.yml'), '«# key: 1\n# other: 2»');
  assert.equal(run(commands.toggleLineComment, '«# key: 1\n# other: 2»', 'config.yml'), '«key: 1\nother: 2»');
});

test('without line comments (HTML, CSS) Ctrl+/ wraps the lines in one block comment, and unwraps it', () => {
  assert.equal(run(commands.toggleLineComment, '  <p>«one</p>\n  <p>two»</p>', 'page.html'), '  <!-- <p>«one</p>\n  <p>two»</p> -->');
  assert.equal(run(commands.toggleLineComment, '  <!-- <p>«one</p>\n  <p>two»</p> -->', 'page.html'), '  <p>«one</p>\n  <p>two»</p>');
  assert.equal(run(commands.toggleLineComment, 'a { color: red; }|', 'site.css'), '/* a { color: red; } */|');
  assert.equal(run(commands.toggleLineComment, '/* a { color: red; } */|', 'site.css'), 'a { color: red; }|');
});

test('Shift+Alt+A puts a block comment around the selection, and takes it off again', () => {
  const commented = run(commands.toggleBlockComment, 'call(«a, b»);');
  assert.equal(commented, 'call(«/* a, b */»);');
  assert.equal(show(commands.toggleBlockComment(parse(commented), editorSyntax('demo.js'))), 'call(«a, b»);');
  assert.equal(run(commands.toggleBlockComment, '  |'), '  /* | */', 'an empty line gets an empty comment with the caret inside');
  assert.equal(run(commands.toggleBlockComment, 'x = 1|', 'demo.py'), '# x = 1|', 'Python has no block comment: a line comment');
});

test('Tab indents the selected lines, or indents to the next stop; Shift+Tab outdents', () => {
  assert.equal(run(commands.tab, 'a|'), 'a |', 'two spaces by default, to the next stop');
  assert.equal(run(commands.tab, 'def f():\n    pass\n|', 'demo.py'), 'def f():\n    pass\n    |', 'the file\'s own four spaces');
  assert.equal(run(commands.tab, '«one\n\ntwo»'), '«  one\n\n  two»', 'blank lines stay empty');
  assert.equal(run(commands.tab, 'a\n\tb\n\tc|'), 'a\n\tb\n\tc\t|', 'a file indented with tabs');
  assert.equal(run(commands.outdentLines, '«  one\n    two\nthree»'), '«one\n  two\nthree»');
  assert.equal(run(commands.outdentLines, 'one|'), null, 'nothing to outdent');
  assert.equal(run(commands.indentLines, 'x|'), '  x|', 'Ctrl+] indents the caret line');
});

test('Alt+Up/Down move the lines with the selection; Shift+Alt+Up/Down copy them', () => {
  assert.equal(show(commands.moveLines(parse('one\ntw|o\nthree'), 'up')), 'tw|o\none\nthree');
  assert.equal(show(commands.moveLines(parse('one\n«two\nthree»\nfour'), 'down')), 'one\nfour\n«two\nthree»');
  assert.equal(commands.moveLines(parse('fi|rst\nlast'), 'up'), null, 'the first line cannot go up');
  assert.equal(commands.moveLines(parse('first\nla|st'), 'down'), null, 'the last line cannot go down');
  assert.equal(show(commands.copyLines(parse('one\ntw|o'), 'down')), 'one\ntwo\ntw|o');
  assert.equal(show(commands.copyLines(parse('tw|o\nend'), 'up')), 'tw|o\ntwo\nend');
});

test('Ctrl+Shift+K deletes the lines, Ctrl+L selects lines, Ctrl+Enter opens a line below', () => {
  assert.equal(show(commands.deleteLines(parse('one\ntw|o\nthree'))), 'one\nth|ree');
  assert.equal(show(commands.deleteLines(parse('one\nlas|t'))), 'one|');
  assert.equal(show(commands.deleteLines(parse('on|ly'))), '|');
  const once = commands.selectLine(parse('one\ntw|o\nthree'));
  assert.equal(show(once), 'one\n«two\n»three');
  assert.equal(show(commands.selectLine(once)), 'one\n«two\nthree»');
  assert.equal(show(commands.insertLineBelow(parse('  ca|ll();\nend'))), '  call();\n  |\nend');
});

test('Enter keeps the indentation, goes deeper after an opener and puts its closer on a line of its own', () => {
  assert.equal(run(commands.newline, '    value|'), '    value\n    |');
  assert.equal(run(commands.newline, 'if (a) {|}'), 'if (a) {\n  |\n}');
  assert.equal(run(commands.newline, '  list = [|'), '  list = [\n    |');
  assert.equal(run(commands.newline, 'def f():|', 'demo.py'), 'def f():\n    |');
  assert.equal(run(commands.newline, 'server:|', 'config.yaml'), 'server:\n  |');
  assert.equal(run(commands.newline, 'a «selected» b'), 'a \n| b');
});

test('the indentation in use is read from the file', () => {
  assert.equal(indentUnit('a\n    b\n        c\n    d\n/**\n * doc\n */', {}), '    ');
  assert.equal(indentUnit('a\n\tb\n\t\tc', {}), '\t');
  assert.equal(indentUnit('plain', {}), '  ');
  assert.equal(indentUnit('plain', editorSyntax('x.py')), '    ');
});

test('VS Code\'s keys run the commands; other keys stay with the text box', () => {
  assert.equal(key('/', 'Slash', { ctrlKey: true }), commands.toggleLineComment);
  assert.equal(key('/', 'NumpadDivide', { metaKey: true }), commands.toggleLineComment, 'Cmd+/ on a Mac, and the keypad');
  assert.equal(key('A', 'KeyA', { altKey: true, shiftKey: true }), commands.toggleBlockComment);
  assert.equal(key('Tab', 'Tab'), commands.tab);
  assert.equal(key('Tab', 'Tab', { shiftKey: true }), commands.outdentLines);
  assert.equal(key(']', 'BracketRight', { ctrlKey: true }), commands.indentLines);
  assert.equal(key('[', 'BracketLeft', { ctrlKey: true }), commands.outdentLines);
  assert.equal(key('K', 'KeyK', { ctrlKey: true, shiftKey: true }), commands.deleteLines);
  assert.equal(key('l', 'KeyL', { ctrlKey: true }), commands.selectLine);
  assert.equal(key('Enter', 'Enter', { ctrlKey: true }), commands.insertLineBelow);
  assert.equal(key('Enter', 'Enter'), commands.newline);
  assert.equal(show(key('ArrowDown', 'ArrowDown', { altKey: true })(parse('a|\nb'))), 'b\na|');
  assert.equal(show(key('ArrowDown', 'ArrowDown', { altKey: true, shiftKey: true })(parse('a|\nb'))), 'a\na|\nb');
  assert.equal(key('Enter', 'Enter', { shiftKey: true }), null, 'Shift+Enter is a plain line break');
  assert.equal(key('a', 'KeyA', { ctrlKey: true }), null, 'Ctrl+A selects all as usual');
  assert.equal(key('ArrowUp', 'ArrowUp', { ctrlKey: true, shiftKey: true }), null, 'Ctrl+Shift+arrows keep selecting by word');
  assert.equal(key('Enter', 'Enter', { ctrlKey: true, shiftKey: true }), null, 'Ctrl+Shift+Enter stays the app\'s maximize key');
});
