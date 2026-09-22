/**
 * Workbench 官网 · Claude 设计规范实现的交互
 *
 * 只做六件事，全部围绕「别让页面卡、脚本挂了也能读」：
 *   1. 把固定尺寸的应用窗口缩放进容器（CSS 拿不到容器宽度，只有这一步必须用脚本）；
 *   2. 活跃度日历的格子（纯装饰，生成一次）；
 *   3. 滚动到就把那一节淡入上浮；
 *   4. 首页布局示例里那几张卡可以真的拖 —— 拖到另一张上松手就对调；那颗「重置布局」把它摆回去；
 *   5. 用量趋势那三个区间标签页是真的能切，柱子按各自的最大值归一化；
 *   6. 终端日志滚进视口时逐行亮起。
 *
 * 文字内容一律在 HTML 里，脚本只负责装饰与交互：脚本没跑，页面照样读得完。
 */
;(function () {
  'use strict'

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* ============ 1. 应用窗口缩放 ============
   * 每个 .stage 在 HTML 上写了 --w / --h（窗口的固有像素尺寸）；
   * 容器宽度除以固有宽度就是缩放比，写回 --s 交给 CSS 的 transform 用。
   * 不放大：容器比窗口宽时保持 1:1 居中，字才不会糊成一片。
   */
  function fitStages() {
    var stages = document.querySelectorAll('[data-stage]')
    for (var i = 0; i < stages.length; i++) {
      var stage = stages[i]
      var base = parseFloat(getComputedStyle(stage).getPropertyValue('--w'))
      if (!base) continue
      var s = Math.min(1, stage.clientWidth / base)
      stage.style.setProperty('--s', String(s))
    }
  }

  /* ============ 2. 活跃度日历 ============
   * 一列一周、一格一天，靠 CSS 的 grid-auto-flow: column 排。
   * 用固定种子的伪随机铺深浅，保证每次打开长得一样（对着一堆随机格子的截图很难比较改动）。
   */
  function drawHeatmaps() {
    var grids = document.querySelectorAll('[data-heatmap]')
    for (var g = 0; g < grids.length; g++) {
      var el = grids[g]
      var n = parseInt(el.getAttribute('data-heatmap'), 10) || 0
      var seed = 20260916
      var frag = document.createDocumentFragment()
      for (var i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        var r = seed / 0x7fffffff
        var cell = document.createElement('i')
        cell.setAttribute(
          'data-l',
          r > 0.975 ? '4' : r > 0.945 ? '3' : r > 0.9 ? '2' : r > 0.8 ? '1' : '0'
        )
        frag.appendChild(cell)
      }
      el.appendChild(frag)
    }
  }

  /* ============ 3. 滚动揭示 ============ */
  function observe(targets, onSee, options) {
    if (reduced || !('IntersectionObserver' in window)) {
      for (var i = 0; i < targets.length; i++) onSee(targets[i])
      return
    }
    var io = new IntersectionObserver(function (entries) {
      for (var j = 0; j < entries.length; j++) {
        if (!entries[j].isIntersecting) continue
        onSee(entries[j].target)
        io.unobserve(entries[j].target)
      }
    }, options)
    for (var k = 0; k < targets.length; k++) io.observe(targets[k])
  }

  function setupReveal() {
    observe(
      document.querySelectorAll('.reveal'),
      function (el) {
        el.classList.add('is-in')
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.05 }
    )

    /* 终端日志：先挂 is-anim 让行藏好，再等观察器放行 —— 反过来写的话，
       用户会看到它们先全部出现、再重播一遍。 */
    var logs = document.querySelectorAll('[data-log]')
    if (reduced) return
    for (var i = 0; i < logs.length; i++) logs[i].classList.add('is-anim')
    observe(
      logs,
      function (el) {
        el.classList.add('is-in')
      },
      { threshold: 0.4 }
    )
  }

  /* ============ 4. 布局示例：真能拖 ============
   * 卡片留在自己的网格槽里（只是被 transform 拖着走），所以拖动过程中网格不会重排 ——
   * 松手时把两张卡的「内容 + 跨度类名」对调，再用 FLIP 把位置变化补成动画。
   * 对调类名而不是挪 DOM，是为了让 grid-column / grid-row 的跨度跟着卡片一起走，
   * 看起来才像布局真的被重排了。
   *
   * 开了「减少动效」也照样能拖：拖拽是交互，不是动效，不该被禁掉；只是省掉换位那一下补间，直接就位。
   */
  function setupLab() {
    var grid = document.getElementById('labGrid')
    if (!grid) return

    var cards = Array.prototype.slice.call(grid.querySelectorAll('[data-card]'))
    if (cards.length < 2) return

    /* 进页面时的样子，留给「重置布局」 */
    var initial = cards.map(function (c) {
      return { html: c.innerHTML, cls: c.className }
    })

    var drag = null

    function highlight(card) {
      for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('is-target', cards[i] === card)
      }
    }

    function swap(a, b) {
      var before = cards.map(function (c) {
        return c.getBoundingClientRect()
      })

      var aHtml = a.innerHTML
      var bHtml = b.innerHTML
      var aCls = a.className
      var bCls = b.className
      a.innerHTML = bHtml
      b.innerHTML = aHtml
      a.className = bCls
      b.className = aCls
      // 活跃度格子是连着渲染好的 DOM 一起换过去的，不用重铺

      if (reduced) return
      cards.forEach(function (c, i) {
        var from = before[i]
        var to = c.getBoundingClientRect()
        var dx = from.left - to.left
        var dy = from.top - to.top
        if (!dx && !dy) return
        c.animate(
          [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }],
          { duration: 420, easing: 'cubic-bezier(.22,.61,.36,1)' }
        )
      })
    }

    grid.addEventListener('pointerdown', function (e) {
      var card = e.target.closest('[data-card]')
      if (!card || drag) return
      e.preventDefault()
      grid.setPointerCapture(e.pointerId)
      drag = { card: card, x: e.clientX, y: e.clientY, moved: false, over: null }
      card.classList.add('is-drag')
    })

    grid.addEventListener('pointermove', function (e) {
      if (!drag) return
      var dx = e.clientX - drag.x
      var dy = e.clientY - drag.y
      if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      drag.moved = true
      drag.card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.03)'

      // 被拖的那张已经 pointer-events: none，所以这里探到的就是它底下的卡
      var under = document.elementFromPoint(e.clientX, e.clientY)
      var target = under && under.closest ? under.closest('[data-card]') : null
      if (target === drag.card) target = null
      drag.over = target
      highlight(target)
    })

    function end() {
      if (!drag) return
      var card = drag.card
      var target = drag.moved ? drag.over : null
      card.classList.remove('is-drag')
      card.style.transform = ''
      highlight(null)
      drag = null
      if (target) swap(card, target)
    }

    grid.addEventListener('pointerup', end)
    grid.addEventListener('pointercancel', end)

    var reset = document.getElementById('labReset')
    if (!reset) return
    reset.addEventListener('click', function () {
      // 快照是在格子铺好之后取的，换回去就是进页面时的样子
      for (var i = 0; i < cards.length; i++) {
        cards[i].className = initial[i].cls
        cards[i].innerHTML = initial[i].html
      }
    })
  }

  /* ============ 5. 用量趋势的三个区间 ============
   * 示意数据：每个区间按固定种子生成一串「当天用量」，再按各自的最大值归一化成柱高。
   * 页面上的合计与区间日期也是这里算出来的 —— 免得图上写着 A、标题写着 B。
   */
  var RANGES = {
    week: { bars: 7, label: '近 7 天', from: '9/16', to: '9/22', seed: 20260922 },
    month: { bars: 30, label: '近 30 天', from: '8/24', to: '9/22', seed: 20260915 },
    thisMonth: { bars: 22, label: '本月', from: '9/1', to: '9/22', seed: 20260901 }
  }

  function rangeValues(range) {
    var seed = range.seed
    var out = []
    for (var i = 0; i < range.bars; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      var r = seed / 0x7fffffff
      // 周末（每 7 天的最后两天）落一点，形状更像真实使用
      var weekend = i % 7 >= 5 ? 0.45 : 1
      out.push((0.35 + r * 2.6) * weekend)
    }
    return out
  }

  function setupUsage() {
    var tabs = document.getElementById('rangeTabs')
    var chart = document.getElementById('rangeChart')
    var sum = document.getElementById('rangeSum')
    var note = document.getElementById('rangeNote')
    if (!tabs || !chart || !sum || !note) return

    var buttons = Array.prototype.slice.call(tabs.querySelectorAll('[data-range]'))

    function draw(key) {
      var range = RANGES[key]
      if (!range) return
      var values = rangeValues(range)
      var total = 0
      var peak = 0
      var i
      for (i = 0; i < values.length; i++) {
        total += values[i]
        if (values[i] > values[peak]) peak = i
      }

      var frag = document.createDocumentFragment()
      for (i = 0; i < values.length; i++) {
        var bar = document.createElement('i')
        bar.style.setProperty('--v', (values[i] / values[peak]).toFixed(3))
        if (i === peak) bar.className = 'is-peak'
        frag.appendChild(bar)
      }
      chart.innerHTML = ''
      chart.appendChild(frag)
      chart.setAttribute('aria-label', range.label + '用量趋势示意')

      sum.textContent = total.toFixed(1) + ' 亿'
      note.textContent = range.from + ' – ' + range.to

      for (i = 0; i < buttons.length; i++) {
        var on = buttons[i].getAttribute('data-range') === key
        buttons[i].classList.toggle('is-on', on)
        buttons[i].setAttribute('aria-selected', on ? 'true' : 'false')
      }
    }

    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-range]')
      if (btn) draw(btn.getAttribute('data-range'))
    })

    draw('week')
  }

  /* ============ 启动 ============ */
  function init() {
    drawHeatmaps()
    fitStages()
    setupReveal()
    setupLab()
    setupUsage()
  }

  var resizeTimer = 0
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(fitStages, 120)
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
