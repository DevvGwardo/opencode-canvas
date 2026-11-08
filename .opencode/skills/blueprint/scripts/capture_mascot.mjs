// Real Hermes Desk owl engine, private headless lab, deterministic pose/clip samples.
// node capture_mascot.mjs --repo /absolute/hermes-desk [--label before]
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  repo: { type: 'string' }, label: { type: 'string', default: 'baseline' },
  character: { type: 'string', default: 'owl' },
} })
if (!values.repo || !path.isAbsolute(values.repo)) throw new Error('--repo must be absolute')
for (const key of ['label', 'character']) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(values[key])) throw new Error(`Invalid --${key}`)
}
const root = path.resolve(values.repo)
const require = createRequire(path.join(root, 'package.json'))
const { chromium } = require('playwright-core')
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const run = `mascot-${values.label}-${randomUUID()}`
const out = path.join(root, 'blueprint-out')
const images = path.join(out, 'ui', run)
const reportPath = path.join(out, 'data', `report-${run}.json`)
await mkdir(images, { recursive: true })
await mkdir(path.dirname(reportPath), { recursive: true })
const report = {
  run, startedAt: new Date().toISOString(), source: 'production-mascot-fixture',
  character: values.character, checks: [], errors: [], screenshots: [],
  visualReview: 'not_reviewed', behavioralVerification: 'not_tested',
  method: { seed: 'blueprint-visual', clock: 'ManualFrameClock at 60Hz',
    deviceScaleFactor: 2, sizesCssPx: [160, 40, 24], clipSamples: 8,
    transitionSamplesMs: [0, 80, 180, 350, 650, 1200], flightPaths: ['arc', 'swoop', 'direct', 'loop'],
    geometrySamplingHz: 60, homeTimestamp: 'actual elapsed manual-clock time' },
  limits: ['Fixtures use production art/engine, not a native app screenshot.',
    'Keyframe GIFs are sampled motion previews, not 60fps recordings.',
    'Production-engine flight/perch chains are exercised; native sidebar delivery, performance and pointer interactions need separate integration tests.'],
}
const check = (name, ok, detail = '') => report.checks.push({ name, ok: Boolean(ok), detail })
let server, browser

try {
  server = await createServer({ root, configFile: path.join(root, 'tools/mascot/vite.lab.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' }) })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2, reducedMotion: 'no-preference',
  })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
  await page.goto(`${origin}/mascot-lab.html?character=${values.character}&capture=1`)
  await page.waitForFunction(() => window.mascotLab?.ready)
  await page.evaluate(() => document.fonts.ready)
  const catalog = await page.evaluate(async character => {
    const [{ createMascot }, { ManualFrameClock }, { characters, agentPalettes }] = await Promise.all([
      import('/src/lib/mascot/engine.ts'), import('/src/lib/mascot/frame-clock.ts'),
      import('/src/lib/mascot/registry.ts'),
    ])
    const rig = characters[character]
    if (!rig) throw new Error(`Unknown character: ${character}`)
    window.bpVisual = { createMascot, ManualFrameClock, rig, handles: [],
      palettes: [{ name: 'default', palette: rig.palette.default }, ...agentPalettes(rig)] }
    return {
      states: Object.keys(rig.motion.states),
      reactions: Object.entries(rig.motion.reactions ?? {}).map(([name, spec]) =>
        ({ name, durationMs: (spec.duration ?? 0.65) * 1000 })),
      clips: Object.entries(rig.clips).map(([name, spec]) =>
        ({ name, durationMs: spec.duration * 1000, loop: Boolean(spec.loop) })),
      palettes: window.bpVisual.palettes.map(({ name }) => name),
    }
  }, values.character)
  report.catalog = catalog

  async function shot(id, group, kind, timeMs = 1200, locator = page.locator('#bp-scene'), extra = {}) {
    const file = path.join(images, `${id}.png`)
    const regions = locator === page ? [] : await page.evaluate(() => {
      const scene = document.querySelector('#bp-scene').getBoundingClientRect()
      return [...document.querySelectorAll('#bp-scene [data-size]')].map(el => {
        const r = el.getBoundingClientRect()
        return { sizeCssPx: Number(el.dataset.size), x: Math.round((r.x - scene.x) * 2),
          y: Math.round((r.y - scene.y) * 2), width: Math.round(r.width * 2), height: Math.round(r.height * 2) }
      })
    })
    const png = await locator.screenshot({ path: file, ...(locator === page ? { fullPage: true } : {}) })
    report.screenshots.push({ id, path: file, group, kind, timeMs, subjectRegions: regions, ...extra,
      width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      sha256: createHash('sha256').update(png).digest('hex') })
  }
  await shot('lab-context', 'lab-context', 'context', 0, page)
  await page.evaluate(() => { document.querySelector('main').style.display = 'none' })

  async function geometry() {
    return page.evaluate(() => {
      const scene = document.querySelector('#bp-scene').getBoundingClientRect()
      const rect = r => ({ x: r.x - scene.x, y: r.y - scene.y, width: r.width, height: r.height })
      const intersection = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      const particles = [...document.querySelectorAll('[data-mascot-particles] use[href="#mascot-fx-letter"]')]
        .filter(el => getComputedStyle(el).display !== 'none' && Number(el.getAttribute('opacity') ?? 1) > .05)
      return [...document.querySelectorAll('#bp-scene [data-size]')].map(host => {
        const svg = host.querySelector('svg')
        const eyes = [...svg.querySelectorAll('[data-mascot-part^="eye-"]')].map(el => el.getBoundingClientRect())
        const letter = svg.querySelector('[data-mascot-part="letter"]')
        const held = letter.getBoundingClientRect()
        const props = held.width > .1 && held.height > .1 ? [held] : []
        const root = svg.querySelector('[data-mascot-part="root"]').getBoundingClientRect()
        const size = Number(host.dataset.size)
        const candidates = particles.map(el => el.getBoundingClientRect()).filter(r =>
          Math.abs(r.x + r.width / 2 - (root.x + root.width / 2)) < size * 1.5)
        const eyeArea = eyes.reduce((sum, r) => sum + r.width * r.height, 0)
        const overlap = Math.min(1, eyes.reduce((sum, eye) =>
          sum + [...props, ...candidates].reduce((n, prop) => n + intersection(eye, prop), 0), 0) / Math.max(1, eyeArea))
        return { sizeCssPx: size, root: rect(root), eyes: eyes.map(rect),
          propEyeOverlapFraction: overlap, method: 'conservative transformed bounding-box intersection, not pixel occlusion' }
      })
    })
  }
  async function fixture(state = 'idle', theme = 'dark', palette = 'default', reduced = false) {
    await page.evaluate(({ state, theme, palette, reduced }) => {
      const bp = window.bpVisual
      bp.handles.forEach(h => h.destroy())
      document.querySelector('#bp-scene')?.remove()
      bp.clock = new bp.ManualFrameClock()
      const scene = document.createElement('section')
      scene.id = 'bp-scene'
      scene.style.cssText = `display:flex;align-items:center;justify-content:center;gap:48px;width:640px;height:300px;background:${theme === 'light' ? '#f5f5f7' : '#1c1c1e'};overflow:visible`
      document.body.append(scene)
      bp.handles = [160, 40, 24].map(size => {
        const el = document.createElement('span')
        el.dataset.size = String(size)
        el.style.cssText = `display:block;width:${size}px;height:${size}px;flex:none;line-height:0`
        scene.append(el)
        return bp.createMascot(el, {
          svg: bp.rig.svg, motion: bp.rig.motion, clips: bp.rig.clips, state, size,
          palette: bp.palettes.find(p => p.name === palette).palette,
          clock: bp.clock, seed: `blueprint-visual:${size}`, idPrefix: `bp-visual-${size}`,
          autonomy: false, interactive: false, reducedMotion: reduced,
        })
      })
    }, { state, theme, palette, reduced })
    await page.waitForFunction(() => window.bpVisual.clock.subscribers === 3)
    await page.evaluate(() => window.bpVisual.clock.advance(1200))
  }
  for (const state of catalog.states) for (const theme of ['dark', 'light']) {
    await fixture(state, theme)
    await shot(`pose-${state}-${theme}`, `poses-${theme}`, 'pose', 1200, undefined,
      { state, theme, geometry: await geometry() })
  }
  for (const palette of catalog.palettes) {
    await fixture('idle', 'dark', palette)
    await shot(`palette-${palette}`, 'palettes', 'palette')
  }
  for (const state of ['thinking', 'talking', 'happy'].filter(s => catalog.states.includes(s))) {
    await fixture(state, 'dark', 'default', true)
    await shot(`reduced-${state}`, 'reduced-motion', 'reduced-motion')
  }
  // State transitions retain the real blended poses rather than recreating isolated states.
  for (const [from, to] of [['idle', 'tool'], ['tool', 'talking'], ['talking', 'error'], ['error', 'idle']]) {
    if (!catalog.states.includes(from) || !catalog.states.includes(to)) continue
    await fixture(from)
    await page.evaluate(state => window.bpVisual.handles.forEach(h => h.setState(state)), to)
    let previous = 0
    for (const [index, time] of [0, 80, 180, 350, 650, 1200].entries()) {
      await page.evaluate(ms => window.bpVisual.clock.advance(ms), time - previous)
      await shot(`transition-${from}-${to}-${index}`, `transition-${from}-${to}`, 'transition', time)
      previous = time
    }
  }
  for (const [kind, entries] of [['clip', catalog.clips], ['reaction', catalog.reactions]]) {
    for (const { name, durationMs, loop } of entries) {
      if (!(durationMs > 0)) throw new Error(`Invalid ${kind} duration: ${name}`)
      await fixture()
      await page.evaluate(({ kind, name }) => {
        for (const h of window.bpVisual.handles) {
          if (kind === 'clip') void h.play(name)
          else h.react(name)
        }
      }, { kind, name })
      const times = [0, .12, .28, .45, .62, .8, 1, loop ? 1.6 : 1.35].map(t => Math.round(t * durationMs))
      let previous = 0
      for (const [index, time] of times.entries()) {
        await page.evaluate(ms => window.bpVisual.clock.advance(ms), time - previous)
        await shot(`${kind}-${name}-${index}`, `${kind}-${name}`, kind, time, undefined,
          { geometry: name === 'deliver' || name === 'message' ? await geometry() : undefined })
        previous = time
      }
    }
  }
  report.deliveryGeometry = []
  for (const kind of ['clip', 'reaction']) {
    await fixture()
    await page.evaluate(kind => window.bpVisual.handles.forEach(h =>
      kind === 'clip' ? void h.play('deliver') : h.react('message')), kind)
    for (let time = 0; time <= 1800; time += 1000 / 60) {
      if (time > 0) await page.evaluate(() => window.bpVisual.clock.advance(1000 / 60, 1000 / 60))
      report.deliveryGeometry.push({ kind, timeMs: Math.round(time), subjects: await geometry() })
    }
  }
  // Private stage fixture exercises the unmodified production Flight and ClipPlayer chain.
  report.flights = []
  for (const reduced of [false, true]) for (const flightPath of ['arc', 'swoop', 'direct', 'loop']) {
    await fixture('idle', 'dark', 'default', reduced)
    await page.evaluate(() => {
      const bp = window.bpVisual
      bp.handles.slice(1).forEach(h => h.destroy())
      bp.handles = bp.handles.slice(0, 1)
      const scene = document.querySelector('#bp-scene')
      scene.style.cssText = 'position:relative;width:1000px;height:600px;background:#1c1c1e'
      const home = scene.querySelector('[data-size]')
      bp.flightSvg = home.querySelector('svg')
      bp.clipCalls = []
      bp.flightStartedAt = bp.clock.now()
      const originalPlay = bp.handles[0].play.bind(bp.handles[0])
      bp.handles[0].play = (name, options) => {
        bp.clipCalls.push({ name, timeMs: Math.round(bp.clock.now() - bp.flightStartedAt) })
        return originalPlay(name, options)
      }
      home.style.cssText = 'position:absolute;left:70px;top:370px;width:160px;height:160px'
      const perch = document.createElement('div')
      perch.id = 'bp-perch'
      perch.dataset.mascotPerch = ''
      perch.style.cssText = 'position:absolute;left:680px;top:330px;width:220px;height:140px;background:#303038;border-radius:12px'
      scene.append(perch)
    })
    const sequence = `flight-${flightPath}${reduced ? '-reduced' : ''}`
    await page.evaluate(flightPath => {
      const bp = window.bpVisual
      bp.flightResult = null
      void bp.handles[0].flyTo(document.querySelector('#bp-perch'), { path: flightPath, speed: 520, perch: true })
        .then(result => { bp.flightResult = result })
    }, flightPath)
    let phase, previousPosition, maxStepPx = 0, landing
    const phases = []
    for (let frame = 0; frame < 480; frame++) {
      await page.evaluate(() => window.bpVisual.clock.advance(1000 / 60, 1000 / 60))
      const sample = await page.evaluate(() => {
        const bp = window.bpVisual
        const svg = bp.flightSvg
        const root = svg.querySelector('[data-mascot-part="root"]')
        const point = new DOMPoint(256, 444).matrixTransform(root.getScreenCTM())
        const location = bp.handles[0].location()
        const phase = location === 'flying' ? bp.clipCalls.at(-1)?.name ?? 'flying' : location
        const target = document.querySelector('#bp-perch').getBoundingClientRect()
        return { phase, location, x: point.x, y: point.y, result: bp.flightResult,
          landingDeltaPx: Math.abs(point.y - target.top) }
      })
      if (previousPosition) maxStepPx = Math.max(maxStepPx, Math.hypot(sample.x - previousPosition.x, sample.y - previousPosition.y))
      previousPosition = sample
      if (sample.phase !== phase) {
        phase = sample.phase
        phases.push({ phase, timeMs: Math.round((frame + 1) * 1000 / 60) })
        await shot(`${sequence}-phase-${phases.length - 1}`, sequence, 'flight',
          Math.round((frame + 1) * 1000 / 60), undefined, { flight: sample })
      }
      if (frame === 50 || frame === 90) await shot(`${sequence}-sample-${frame}`, sequence, 'flight',
        Math.round((frame + 1) * 1000 / 60), undefined, { flight: sample })
      if (sample.result) { landing = sample; break }
    }
    check(`${sequence} arrives at its perch`, landing?.result === 'arrived', landing)
    check(`${sequence} lands within two CSS pixels`, (landing?.landingDeltaPx ?? Infinity) <= 2, landing)
    const clipCalls = await page.evaluate(() => window.bpVisual.clipCalls)
    if (!reduced) check(`${sequence} retains takeoff, flight and landing choreography`,
      ['takeoff', 'fly', 'land'].every(name => clipCalls.some(call => call.name === name)), clipCalls)
    report.flights.push({ path: flightPath, reducedMotion: reduced, result: landing?.result,
      clipCalls, phases, maxStepPx, landing })
    await page.evaluate(() => {
      const bp = window.bpVisual
      bp.homeResult = null
      void bp.handles[0].goHome({ speed: 520 }).then(result => { bp.homeResult = result })
    })
    let homeTimeMs = 0
    for (let frame = 0; frame < 480; frame++) {
      await page.evaluate(() => window.bpVisual.clock.advance(1000 / 60, 1000 / 60))
      homeTimeMs = Math.round((frame + 1) * 1000 / 60)
      if (await page.evaluate(() => window.bpVisual.homeResult)) break
    }
    const home = await page.evaluate(() => ({
      result: window.bpVisual.homeResult, location: window.bpVisual.handles[0].location(),
    }))
    check(`${sequence} returns home`, home.result === 'arrived' && home.location === 'home', home)
    await shot(`${sequence}-home`, sequence, 'flight', homeTimeMs, undefined, { flight: home })
  }
  check('All discovered poses have light and dark captures',
    report.screenshots.filter(s => s.kind === 'pose').length === catalog.states.length * 2)
  for (const kind of ['clip', 'reaction']) {
    const expected = catalog[kind === 'clip' ? 'clips' : 'reactions'].length * 8
    check(`All discovered ${kind}s have eight sampled frames`,
      report.screenshots.filter(s => s.kind === kind).length === expected, { expected })
  }
} catch (error) {
  report.errors.push(error.message)
  check('Mascot capture completed', false, error.message)
} finally {
  for (const resource of [browser, server]) {
    try { await resource?.close() } catch (error) { report.errors.push(`Cleanup: ${error.message}`) }
  }
  check('No browser or harness errors', report.errors.length === 0, report.errors)
  report.finishedAt = new Date().toISOString()
  report.status = report.checks.every(c => c.ok) ? 'captured' : 'failed'
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
}
console.log(JSON.stringify({ status: report.status, report: reportPath, screenshots: report.screenshots.length }))
process.exitCode = report.status === 'captured' ? 0 : 1
