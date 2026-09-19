// Workbench 官网脚本：滚动入场（带兜底）、导航高亮、主题切换、数字滚动、粒子网格背景

(function () {
  'use strict';

  var root = document.documentElement;

  // ---- 滚动入场 ----
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -36px 0px' });
  reveals.forEach(function (el) { io.observe(el); });
  // 兜底：后台标签页里 IO 可能迟迟不回调，2.5s 后强制显形，绝不让区块停在空白
  window.addEventListener('load', function () {
    setTimeout(function () {
      reveals.forEach(function (el) { el.classList.add('in'); });
    }, 2500);
  });

  // ---- 数字滚动 ----
  var counter = document.querySelector('.count');
  if (counter) {
    var cio = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      cio.disconnect();
      var to = parseFloat(counter.dataset.to);
      var start = null;
      function step(ts) {
        if (!start) start = ts;
        var p = Math.min((ts - start) / 1400, 1);
        counter.textContent = (to * (1 - Math.pow(1 - p, 3))).toFixed(1);
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }, { threshold: 0.5 });
    cio.observe(counter);
  }

  // ---- 顶栏滚动状态 ----
  var topbar = document.getElementById('topbar');
  function onScroll() { topbar.classList.toggle('scrolled', window.scrollY > 12); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- 当前区块导航高亮 ----
  var links = Array.prototype.slice.call(document.querySelectorAll('.topnav a'));
  var sections = links.map(function (a) { return document.querySelector(a.getAttribute('href')); });
  var sio = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a, i) { a.classList.toggle('active', sections[i] === e.target); });
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  sections.forEach(function (s) { if (s) sio.observe(s); });

  // ---- 主题切换 ----
  try {
    var saved = localStorage.getItem('wb-site-theme');
    if (saved) root.dataset.theme = saved;
  } catch (err) { /* 隐私模式读不到就算了 */ }
  document.getElementById('themeBtn').addEventListener('click', function () {
    var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('wb-site-theme', next); } catch (err) { /* 同上 */ }
  });

  // ---- 高科技背景：双层景深粒子 + 数据包脉冲 ----
  (function () {
    var canvas = document.getElementById('techbg');
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = 0, h = 0;
    var far = [], near = [], pulses = [];
    var mouse = { x: -9999, y: -9999 };
    var colors = {};

    function readColors() {
      var cs = getComputedStyle(root);
      colors.line = cs.getPropertyValue('--bg-line').trim();
      colors.far = cs.getPropertyValue('--bg-far').trim();
      colors.node = cs.getPropertyValue('--bg-node').trim();
      colors.acc = cs.getPropertyValue('--st-ok').trim();
    }
    new MutationObserver(readColors).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    readColors();

    function makeLayer(n, speed) {
      var arr = [];
      for (var i = 0; i < n; i++) {
        arr.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - .5) * speed,
          vy: (Math.random() - .5) * speed,
          r: Math.random() * 1.2 + .6,
          acc: Math.random() < .1
        });
      }
      return arr;
    }

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var area = w * h;
      far = makeLayer(Math.min(70, Math.round(area / 26000)), .12);
      near = makeLayer(Math.min(46, Math.round(area / 38000)), .3);
      pulses = [];
    }

    function linkLayer(layer, maxDist, alpha, stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      for (var i = 0; i < layer.length; i++) {
        var a = layer[i];
        for (var j = i + 1; j < layer.length; j++) {
          var b = layer[j];
          var dx = a.x - b.x, dy = a.y - b.y;
          var d2 = dx * dx + dy * dy;
          if (d2 >= maxDist * maxDist) continue;
          var d = Math.sqrt(d2);
          ctx.globalAlpha = (1 - d / maxDist) * alpha;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    function drawLayer(layer, fill, alpha, rMul) {
      ctx.fillStyle = fill;
      for (var i = 0; i < layer.length; i++) {
        var p = layer[i];
        ctx.globalAlpha = p.acc ? .9 : alpha;
        ctx.fillStyle = p.acc ? colors.acc : fill;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * rMul, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function moveLayer(layer) {
      for (var i = 0; i < layer.length; i++) {
        var p = layer[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx = -p.vx;
        if (p.y < 0 || p.y > h) p.vy = -p.vy;
      }
    }

    // 数据包：沿近层节点对之间飞一段，落到下一个节点后消失
    function spawnPulse() {
      if (near.length < 2 || pulses.length > 5) return;
      var a = near[Math.floor(Math.random() * near.length)];
      var best = null, bestD = 1e9;
      for (var i = 0; i < near.length; i++) {
        var b = near[i];
        if (b === a) continue;
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 40 && d < bestD) { best = b; bestD = d; }
      }
      if (best && bestD < 260) pulses.push({ a: a, b: best, t: 0, sp: .012 + Math.random() * .01 });
    }

    function drawPulses() {
      for (var i = pulses.length - 1; i >= 0; i--) {
        var p = pulses[i];
        p.t += p.sp;
        if (p.t >= 1) { pulses.splice(i, 1); continue; }
        var x = p.a.x + (p.b.x - p.a.x) * p.t;
        var y = p.a.y + (p.b.y - p.a.y) * p.t;
        var fade = Math.sin(p.t * Math.PI);
        ctx.strokeStyle = colors.acc;
        ctx.globalAlpha = fade * .3;
        ctx.beginPath();
        ctx.moveTo(p.a.x, p.a.y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = fade * .95;
        ctx.fillStyle = colors.acc;
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function drawMouse() {
      ctx.strokeStyle = colors.acc;
      ctx.lineWidth = 1;
      for (var i = 0; i < near.length; i++) {
        var p = near[i];
        var d = Math.hypot(p.x - mouse.x, p.y - mouse.y);
        if (d > 170) continue;
        ctx.globalAlpha = (1 - d / 170) * .5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(mouse.x, mouse.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      linkLayer(far, 110, .18, colors.far);
      linkLayer(near, 140, .4, colors.line);
      drawLayer(far, colors.far, .35, .8);
      drawLayer(near, colors.node, .7, 1.2);
      drawPulses();
      drawMouse();
    }

    var lastSpawn = 0;
    function frame(ts) {
      moveLayer(far);
      moveLayer(near);
      if (ts - lastSpawn > 900) { lastSpawn = ts; spawnPulse(); }
      draw();
      requestAnimationFrame(frame);
    }

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
    window.addEventListener('mouseout', function () { mouse.x = -9999; mouse.y = -9999; });

    resize();
    draw();
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      requestAnimationFrame(frame);
    }
  })();
})();
