'use strict'
/* eslint-env browser */
/* globals chrome */

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.toString()
  }

  if (error && typeof error.message === 'string' && error.message) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    const serialized = JSON.stringify(error)

    if (serialized && serialized !== '{}') {
      return serialized
    }
  } catch {
    // Continue.
  }

  return String(error)
}

// Manifest v2 polyfill
if (chrome.runtime.getManifest().manifest_version === 2) {
  chrome.action = chrome.browserAction
}

// eslint-disable-next-line no-unused-vars
const Utils = {
  tabAwareMethodArgumentCounts: Object.freeze({
    analyzeDom: 5,
    analyzeJs: 5,
    detectTechnology: 2,
    onContentLoad: 6,
    onInitialScanComplete: 1,
  }),

  agent: chrome.runtime.getURL('/').startsWith('moz-')
    ? 'firefox'
    : chrome.runtime.getURL('/').startsWith('safari-')
    ? 'safari'
    : 'chrome',

  /**
   * Use promises instead of callbacks
   * @param {Object} context
   * @param {String} method
   * @param  {...any} args
   */
  promisify(context, method, ...args) {
    return new Promise((resolve, reject) => {
      context[method](...args, (...args) => {
        if (chrome.runtime.lastError) {
          return reject(Utils.normalizeError(chrome.runtime.lastError))
        }

        resolve(...args)
      })
    })
  },

  /**
   * Open a browser tab
   * @param {String} url
   * @param {Boolean} active
   */
  open(url, active = true) {
    chrome.tabs.create({ url, active })
  },

  /**
   * Close current browser tab
   */
  close(tabId) {
    chrome.tabs.remove(tabId, () => {
      if (
        chrome.runtime.lastError &&
        !Utils.isMissingTabError(chrome.runtime.lastError)
      ) {
        // eslint-disable-next-line no-console
        console.error(
          'wappalyzer | utils |',
          Utils.normalizeError(chrome.runtime.lastError)
        )
      }
    })
  },

  getErrorMessage,

  normalizeError(error) {
    return error instanceof Error ? error : new Error(getErrorMessage(error))
  },

  isMissingTabError(error) {
    return /\b(No tab with id|Receiving end does not exist)\b/i.test(
      getErrorMessage(error)
    )
  },

  isMessageChannelClosedError(error) {
    return (
      Utils.isMissingTabError(error) ||
      /(?:message (?:port|channel) closed|message channel is closed|Extension context invalidated)/i.test(
        getErrorMessage(error)
      )
    )
  },

  withMessageSenderContext(func, args, sender) {
    const argumentCount = Utils.tabAwareMethodArgumentCounts[func]
    const tabId = sender?.tab?.id

    if (typeof argumentCount !== 'number' || typeof tabId !== 'number') {
      return args
    }

    const contextArgs = Array.isArray(args) ? [...args] : []

    while (contextArgs.length < argumentCount) {
      contextArgs.push(undefined)
    }

    return [...contextArgs, tabId, sender.frameId]
  },

  /**
   * Get value from local storage
   * @param {String} name
   * @param {string|mixed|null} defaultValue
   */
  async getOption(name, defaultValue = null) {
    try {
      /*
      try {
        const managed = await Utils.promisify(
          chrome.storage.managed,
          'get',
          name
        )

        if (managed[name] !== undefined) {
          return managed[name]
        }
      } catch {
        // Continue
      }
      */

      const option = await Utils.promisify(chrome.storage.local, 'get', name)

      if (option[name] !== undefined) {
        return option[name]
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('wappalyzer | utils |', Utils.normalizeError(error))
    }

    return defaultValue
  },

  /**
   * Set value in local storage
   * @param {String} name
   * @param {String} value
   */
  async setOption(name, value) {
    try {
      await Utils.promisify(chrome.storage.local, 'set', {
        [name]: value,
      })
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('wappalyzer | utils |', Utils.normalizeError(error))
    }
  },

  trackingDataPermissions: [
    'browsingActivity',
    'websiteContent',
    'technicalAndInteraction',
  ],
  plusDataPermissions: ['browsingActivity', 'authenticationInfo'],
  dataConsentSupported: null,

  async initDataConsent() {
    if (Utils.agent !== 'firefox') {
      return
    }

    try {
      const permissions = await chrome.permissions.getAll()
      Utils.dataConsentSupported = Array.isArray(permissions.data_collection)
    } catch {
      // Keep local detection usable, but never treat a failed lookup as consent.
      Utils.dataConsentSupported = null
    }
  },

  async hasDataPermissions(types) {
    if (Utils.agent !== 'firefox') {
      return true
    }

    try {
      const permissions = await chrome.permissions.getAll()

      // Older Firefox retains the existing in-extension consent flow.
      return (
        !Array.isArray(permissions.data_collection) ||
        types.every((type) => permissions.data_collection.includes(type))
      )
    } catch {
      return false
    }
  },

  requestDataPermissions(types) {
    // Call directly from the click handler, before storage or other awaits,
    // so Firefox retains the user activation required by permissions.request.
    if (Utils.agent !== 'firefox' || Utils.dataConsentSupported === false) {
      return Promise.resolve(true)
    }

    return chrome.permissions
      .request({ data_collection: types })
      .catch(() => false)
  },

  /**
   * Apply internationalization
   */
  i18n() {
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      const message = chrome.i18n.getMessage(node.dataset.i18n)
      const link =
        node.dataset.i18n === 'termsContent' &&
        /<a href=['"]https:\/\/(?:www\.)?wappalyzer\.com['"]>([^<]*)<\/a>/.exec(
          message
        )

      node.textContent = ''

      if (!link) {
        node.textContent = message
        return
      }

      const anchor = document.createElement('a')
      anchor.href = 'https://www.wappalyzer.com'
      anchor.textContent = link[1]
      node.append(
        message.slice(0, link.index),
        anchor,
        message.slice(link.index + link[0].length)
      )
    })
  },

  sendMessage(source, func, args) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          source,
          func,
          args: args ? (Array.isArray(args) ? args : [args]) : [],
        },
        (response) => {
          chrome.runtime.lastError
            ? reject(Utils.normalizeError(chrome.runtime.lastError))
            : resolve(response)
        }
      )
    })
  },

  globEscape(string) {
    return string.replace(/\*/g, '\\*')
  },
}
