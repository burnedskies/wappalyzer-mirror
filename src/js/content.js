'use strict'
/* eslint-env browser */
/* globals chrome, globalThis */

function yieldToMain() {
  if (globalThis?.scheduler?.yield) {
    return globalThis?.scheduler.yield()
  }

  // Fall back to yielding with setTimeout.
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const MAX_TEXT_LENGTH = 25000
const MAX_INLINE_SCRIPT_COUNT = 50
const MAX_INLINE_SCRIPT_CHARS = 200000
const MAX_DOM_TEXT_LENGTH = 1000000
const MAX_TECH_DETECTIONS = 50
const LANGUAGE_DETECTION_SAMPLE_LENGTH = 5000
const LANGUAGE_DETECTION_MIN_TEXT_LENGTH = 250
const LANGUAGE_DETECTION_MIN_ALPHA_CHARS = 120
const LANGUAGE_DETECTION_MIN_WORDS = 20
const LANGUAGE_DETECTION_MIN_PERCENTAGE = 85
const LANGUAGE_DETECTION_MIN_MARGIN = 25

function normalizeLanguageTag(value = '') {
  const tokens = `${value || ''}`
    .trim()
    .replace(/_/g, '-')
    .split('-')
    .filter(Boolean)

  const [language, ...subtags] = tokens

  if (!/^[a-z]{2}$/i.test(language || '')) {
    return ''
  }

  const region = subtags.find((subtag) => /^[a-z]{2}$/i.test(subtag))

  return `${language.toLowerCase()}${region ? `-${region.toUpperCase()}` : ''}`
}

function getBaseLanguage(value = '') {
  const language = normalizeLanguageTag(value)

  return language ? language.split('-')[0] : ''
}

function getLanguageSampleText() {
  // eslint-disable-next-line unicorn/prefer-text-content
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()

  if (text.length < LANGUAGE_DETECTION_MIN_TEXT_LENGTH) {
    return ''
  }

  const sample = text.slice(0, LANGUAGE_DETECTION_SAMPLE_LENGTH)
  const alphaChars = (sample.match(/\p{L}/gu) || []).length
  const words = sample.match(/\p{L}{2,}/gu) || []

  if (
    alphaChars < LANGUAGE_DETECTION_MIN_ALPHA_CHARS ||
    words.length < LANGUAGE_DETECTION_MIN_WORDS
  ) {
    return ''
  }

  return sample
}

function detectLanguageFromVisibleText() {
  if (!chrome.i18n.detectLanguage) {
    return ''
  }

  const sample = getLanguageSampleText()

  if (!sample) {
    return ''
  }

  return new Promise((resolve) => {
    chrome.i18n.detectLanguage(sample, ({ languages = [] } = {}) => {
      const rankedLanguages = languages
        .map(({ language, percentage }) => ({
          language: getBaseLanguage(language),
          percentage: parseInt(percentage, 10) || 0,
        }))
        .filter(({ language }) => language)
        .sort(({ percentage: a }, { percentage: b }) => (a < b ? 1 : -1))

      const [top, next] = rankedLanguages

      if (
        !top ||
        top.percentage < LANGUAGE_DETECTION_MIN_PERCENTAGE ||
        top.percentage - (next ? next.percentage : 0) <
          LANGUAGE_DETECTION_MIN_MARGIN
      ) {
        resolve('')

        return
      }

      resolve(top.language)
    })
  })
}

function inject(src, id, message) {
  return new Promise((resolve) => {
    // Inject a script tag into the page to access methods of the window object
    const script = document.createElement('script')

    script.onload = () => {
      const onMessage = ({ data }) => {
        if (!data.wappalyzer || !data.wappalyzer[id]) {
          return
        }

        window.removeEventListener('message', onMessage)

        resolve(data.wappalyzer[id])

        script.remove()
      }

      window.addEventListener('message', onMessage)

      window.postMessage({
        wappalyzer: message,
      })
    }

    script.setAttribute('src', chrome.runtime.getURL(src))

    document.body.appendChild(script)
  })
}

function getJs(technologies) {
  return inject('js/js.js', 'js', {
    technologies: technologies
      .filter(({ js }) => Object.keys(js).length)
      .map(({ name, js }) => ({ name, chains: Object.keys(js) })),
  })
}

async function getDom(technologies) {
  const startTime = performance.now()
  const _technologies = technologies
    .filter(({ dom }) => dom && dom.constructor === Object)
    .map(({ name, dom }) => ({ name, dom }))

  const detections = await getDomDetections(_technologies)

  const returnVal = [
    ...(await inject('js/dom.js', 'dom', {
      technologies: _technologies.filter(({ dom }) =>
        Object.values(dom)
          .flat()
          .some(({ properties }) => properties)
      ),
    })),
    ...detections,
  ]
  performance.measure('Wappalyzer: getDom', {
    start: startTime,
    end: performance.now(),
  })
  return returnVal
}

async function getDomDetections(_technologies) {
  const technologies = []
  const detectionKeys = new Set()
  const detectionCounts = new Map()
  const selectorCache = new Map()
  let lastYield = performance.now()

  const shouldYield = () => performance.now() - lastYield > 16
  const updateYield = async () => {
    if (shouldYield()) {
      await yieldToMain()
      lastYield = performance.now()
    }
  }
  const getDetectionCount = (name) => detectionCounts.get(name) || 0
  const addDetection = (name, key, detection) => {
    if (
      detectionKeys.has(key) ||
      getDetectionCount(name) >= MAX_TECH_DETECTIONS
    ) {
      return false
    }

    detectionKeys.add(key)
    detectionCounts.set(name, getDetectionCount(name) + 1)
    technologies.push(detection)

    return true
  }

  for (const { name, dom } of _technologies) {
    const toScalar = (value) =>
      typeof value === 'string' || typeof value === 'number' ? value : !!value

    await updateYield()

    for (const selector of Object.keys(dom)) {
      if (getDetectionCount(name) >= MAX_TECH_DETECTIONS) {
        break
      }

      let nodes = []

      if (selectorCache.has(selector)) {
        nodes = selectorCache.get(selector)
      } else {
        try {
          nodes = document.querySelectorAll(selector)
        } catch (error) {
          Content.driver('error', error)
        }

        selectorCache.set(selector, nodes)
      }

      if (!nodes.length) {
        continue
      }

      for (const { exists, text, properties, attributes } of dom[selector]) {
        for (const node of nodes) {
          if (getDetectionCount(name) >= MAX_TECH_DETECTIONS) {
            break
          }

          if (exists) {
            addDetection(name, `${name}|${selector}|exists`, {
              name,
              selector,
              exists: '',
            })
          }

          if (text) {
            // eslint-disable-next-line unicorn/prefer-text-content
            const value = (node.innerText ? node.innerText.trim() : '').slice(
              0,
              MAX_DOM_TEXT_LENGTH
            )

            if (value) {
              addDetection(name, `${name}|${selector}|text|${value}`, {
                name,
                selector,
                text: value,
              })
            }
          }

          if (properties) {
            for (const property of Object.keys(properties)) {
              if (Object.prototype.hasOwnProperty.call(node, property)) {
                const value = node[property]

                if (typeof value !== 'undefined') {
                  addDetection(
                    name,
                    `${name}|${selector}|property|${property}|${toScalar(
                      value
                    )}`,
                    {
                      name,
                      selector,
                      property,
                      value: toScalar(value),
                    }
                  )
                }
              }
            }
          }

          if (attributes) {
            for (const attribute of Object.keys(attributes)) {
              if (node.hasAttribute(attribute)) {
                const value = node.getAttribute(attribute)

                addDetection(
                  name,
                  `${name}|${selector}|attribute|${attribute}|${toScalar(
                    value
                  )}`,
                  {
                    name,
                    selector,
                    attribute,
                    value: toScalar(value),
                  }
                )
              }
            }
          }

          await updateYield()
        }
      }
    }
  }

  return technologies
}

function getCookies() {
  const cookies = {}

  if (!document.cookie) {
    return cookies
  }

  for (const cookie of document.cookie.split('; ')) {
    const [name, ...value] = cookie.split('=')

    cookies[name] = [value.join('=')]
  }

  return cookies
}

function getScriptSources() {
  return Array.from(document.scripts)
    .filter(({ src }) => src && !src.startsWith('data:text/javascript;'))
    .map(({ src }) => src)
}

function getMeta() {
  const meta = {}

  for (const node of document.querySelectorAll('meta')) {
    const key = node.getAttribute('name') || node.getAttribute('property')

    if (!key) {
      continue
    }

    const content = node.getAttribute('content')
    const normalizedKey = key.toLowerCase()

    meta[normalizedKey] = meta[normalizedKey] || []
    meta[normalizedKey].push(content)
  }

  return meta
}

async function getHeavySignals() {
  await yieldToMain()

  // Text
  // eslint-disable-next-line unicorn/prefer-text-content
  const text = document.body.innerText
    .replace(/\s+/g, ' ')
    .slice(0, MAX_TEXT_LENGTH)

  // CSS rules
  const css = []

  try {
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rules of Array.from(sheet.cssRules)) {
        css.push(rules.cssText)

        if (css.length >= 3000) {
          break
        }
      }

      if (css.length >= 3000) {
        break
      }
    }
  } catch (error) {
    // Continue
  }

  await yieldToMain()

  const scripts = []
  let totalScriptChars = 0

  for (const node of Array.from(document.scripts)) {
    const script = node.textContent

    if (!script) {
      continue
    }

    const remainingChars = MAX_INLINE_SCRIPT_CHARS - totalScriptChars

    if (remainingChars <= 0 || scripts.length >= MAX_INLINE_SCRIPT_COUNT) {
      break
    }

    scripts.push(script.slice(0, remainingChars))
    totalScriptChars += Math.min(script.length, remainingChars)
  }

  return {
    text,
    css: css.join('\n'),
    scripts,
  }
}

const Content = {
  cache: {},
  language: '',

  analyzedRequires: [],

  /**
   * Initialise content script
   */
  async init() {
    const url = location.href

    if (await Content.driver('isDisabledDomain', url)) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))

    try {
      Content.language = normalizeLanguageTag(
        document.documentElement.getAttribute('lang') ||
          document.documentElement.getAttribute('xml:lang')
      )

      if (!Content.language) {
        Content.language = await detectLanguageFromVisibleText()
      }

      Content.cache = {
        cookies: getCookies(),
        meta: getMeta(),
        scriptSrc: getScriptSources(),
      }

      // Detect Google Ads
      if (/^(www\.)?google(\.[a-z]{2,3}){1,2}$/.test(location.hostname)) {
        const ads = document.querySelectorAll(
          '#tads [data-text-ad] a[data-pcu]'
        )

        for (const ad of ads) {
          Content.driver('detectTechnology', [ad.href, 'Google Ads'])
        }
      }

      // Detect Microsoft Ads
      if (/^(www\.)?bing\.com$/.test(location.hostname)) {
        const ads = document.querySelectorAll('.b_ad .b_adurl cite')

        for (const ad of ads) {
          const url = ad.textContent.split(' ')[0].trim()

          Content.driver('detectTechnology', [
            url.startsWith('http') ? url : `http://${url}`,
            'Microsoft Advertising',
          ])
        }
      }

      // Detect Facebook Ads
      if (/^(www\.)?facebook\.com$/.test(location.hostname)) {
        const ads = document.querySelectorAll('a[aria-label="Advertiser"]')

        for (const ad of ads) {
          const urls = [
            ...new Set([
              `https://${decodeURIComponent(
                ad.href.split(/^.+\?u=https%3A%2F%2F/).pop()
              )
                .split('/')
                .shift()}`,

              // eslint-disable-next-line unicorn/prefer-text-content
              `https://${ad.innerText.split('\n').pop()}`,
            ]),
          ]

          urls.forEach((url) =>
            Content.driver('detectTechnology', [url, 'Facebook Ads'])
          )
        }
      }

      await Content.driver('onContentLoad', [
        url,
        Content.cache,
        Content.language,
      ])

      const technologies = await Content.driver('getTechnologies')

      await Content.onGetTechnologies(technologies)

      Object.assign(Content.cache, await getHeavySignals())

      Content.analyzedRequires = []

      await Content.driver('onContentLoad', [
        url,
        Content.cache,
        Content.language,
      ])

      // Delayed second pass to capture async JS
      await new Promise((resolve) => setTimeout(resolve, 5000))

      const js = await getJs(technologies)

      await Content.driver('analyzeJs', [url, js])
    } catch (error) {
      Content.driver('error', error)
    }
  },

  /**
   * Enable scripts to call Driver functions through messaging
   * @param {Object} message
   * @param {Object} sender
   * @param {Function} callback
   */
  onMessage({ source, func, args }, sender, callback) {
    if (!func) {
      return
    }

    Content.driver('log', { source, func, args })

    if (!Content[func]) {
      Content.error(new Error(`Method does not exist: Content.${func}`))

      return
    }

    Promise.resolve(Content[func].call(Content[func], ...(args || [])))
      .then(callback)
      .catch(Content.error)

    return !!callback
  },

  driver(func, args) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          source: 'content.js',
          func,
          args:
            args instanceof Error
              ? [args.toString()]
              : args
              ? Array.isArray(args)
                ? args
                : [args]
              : [],
        },
        (response) => {
          chrome.runtime.lastError
            ? func === 'error'
              ? resolve()
              : Content.driver(
                  'error',
                  new Error(
                    `${
                      chrome.runtime.lastError.message
                    }: Driver.${func}(${JSON.stringify(args)})`
                  )
                )
            : resolve(response)
        }
      )
    })
  },

  async analyzeRequires(url, requires) {
    await Promise.all(
      requires.map(async ({ name, categoryId, technologies }) => {
        const id = categoryId ? `category:${categoryId}` : `technology:${name}`

        if (
          !Content.analyzedRequires.includes(id) &&
          Object.keys(Content.cache).length
        ) {
          Content.analyzedRequires.push(id)

          await Promise.all([
            Content.onGetTechnologies(technologies, name, categoryId),
            Content.driver('onContentLoad', [
              url,
              Content.cache,
              Content.language,
              name,
              categoryId,
            ]),
          ])
        }
      })
    )
  },

  /**
   * Callback for getTechnologies
   * @param {Array} technologies
   */
  async onGetTechnologies(technologies = [], requires, categoryRequires) {
    const url = location.href

    const js = await getJs(technologies)
    const dom = await getDom(technologies)

    await Promise.all([
      Content.driver('analyzeJs', [url, js, requires, categoryRequires]),
      Content.driver('analyzeDom', [url, dom, requires, categoryRequires]),
    ])
  },
}

// Enable messaging between scripts
chrome.runtime.onMessage.addListener(Content.onMessage)

if (/complete|interactive|loaded/.test(document.readyState)) {
  Content.init()
} else {
  document.addEventListener('DOMContentLoaded', Content.init)
}
