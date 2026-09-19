// 右下角风格切换浮标：在五个风格之间一键跳转
(function () {
  'use strict';
  var styles = [
    { file: 'index.html', name: '工程编辑部', tag: '暗色 · bento · 粒子网格' },
    { file: 'styles/s2-swiss.html', name: '瑞士国际主义', tag: '亮纸 · 网格 · 点阵波' },
    { file: 'styles/s3-terminal.html', name: '终端 CRT', tag: '黑绿 · 等宽 · 代码雨' },
    { file: 'styles/s4-magazine.html', name: '衬线杂志', tag: '纸白 · 宋体 · 字母漂移' },
    { file: 'styles/s5-brutalist.html', name: '新粗野主义', tag: '粗边 · 硬阴影 · 几何漂浮' },
    { file: 'styles/s6-guofeng.html', name: '国风水墨', tag: '宣纸 · 竖排 · 墨晕远山' },
    { file: 'styles/s7-blueprint.html', name: '工程蓝图', tag: '蓝底 · 图签 · 巡画光标' },
    { file: 'styles/s8-pixel.html', name: '像素复古', tag: '8-bit · HUD · 方块雨' },
    { file: 'styles/s9-bauhaus.html', name: '包豪斯', tag: '红黄蓝 · 构成 · 几何漂浮' },
    { file: 'styles/s10-riso.html', name: 'Riso 孔版', tag: '双色套印 · 颗粒 · 错位色版' }
  ];
  var path = location.pathname.replace(/\\/g, '/');
  var inStyles = /\/styles\/[^/]+$/.test(path);
  var here = inStyles ? path.split('/').pop() : 'index.html';
  function href(file) {
    if (inStyles) return file === 'index.html' ? '../index.html' : (file.indexOf('styles/') === 0 ? file.slice(7) : file);
    return file;
  }
  var box = document.createElement('div');
  box.className = 'wb-switcher';
  var html = '<div class="wb-list">' + styles.map(function (s) {
    var cur = (s.file === 'index.html' && here === 'index.html') || s.file === 'styles/' + here;
    return '<a' + (cur ? ' class="cur"' : '') + ' href="' + href(s.file) + '"><b>' + s.name + '</b><span>' + s.tag + '</span></a>';
  }).join('') + '</div><button class="wb-toggle" type="button">风格 · ' + styles.length + '</button>';
  box.innerHTML = html;
  box.querySelector('.wb-toggle').addEventListener('click', function (e) {
    e.stopPropagation();
    box.classList.toggle('open');
  });
  document.addEventListener('click', function () { box.classList.remove('open'); });
  document.body.appendChild(box);
})();
