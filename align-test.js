// 对齐测试：量出哪种补位能让「日」与甲行（08日）严丝合缝
const rows = [
  '\u753208\u65e5',
  '\u4e5911\u65e5',
  '\u4e1911\u2009\u65e5',
  '\u4e0111\u2009\u2009\u65e5',
  '\u620a11\u2009\u2009\u2009\u65e5',
  '\u5df111 \u65e5',
  '\u5e9a11  \u65e5',
  '\u8f9b10\u2009\u65e5',
  '\u58ec10 \u65e5',
  '\u767811\u200a\u65e5',
  '\u5b5011\u00b7\u65e5',
  '\u4e1110\u00b7\u65e5',
  '\u5bc5\uff11\uff11\u65e5',
  '\u536f08 \u65e5',
];
$done({ title: '对齐测试', content: rows.join('\n'), icon: 'ruler', 'icon-color': '#FF9500' });
