'use strict'
/* eslint-env browser */
/* globals chrome, Utils */

const { agent, open, i18n, getOption, setOption, promisify, sendMessage } =
  Utils

const baseUrl = 'https://www.wappalyzer.com'
const utm = '?utm_source=popup&utm_medium=extension&utm_campaign=wappalyzer'
const leadGenerationUrl = `${baseUrl}/lead-generation/${utm}`
const dataEnrichmentUrl = `${baseUrl}/data-enrichment/${utm}`
const apiKeyRetryDelays = [3000, 5000, 10000, 15000, 30000]
const apiKeyActivationWindow = 1000 * 60 * 5

const footers = [
  {
    heading: 'footerCtaNeedMoreHeading',
    body: 'footerCtaNeedMoreBody',
    buttonText: 'footerCtaNeedMoreButton',
    buttonLink: leadGenerationUrl,
  },
  {
    heading: 'footerCtaProspectsHeading',
    body: 'footerCtaProspectsBody',
    buttonText: 'footerCtaProspectsButton',
    buttonLink: leadGenerationUrl,
  },
  {
    heading: 'footerCtaCrmHeading',
    body: 'footerCtaCrmBody',
    buttonText: 'footerCtaCrmButton',
    buttonLink: dataEnrichmentUrl,
  },
  {
    heading: 'footerCtaListsHeading',
    body: 'footerCtaListsBody',
    buttonText: 'footerCtaListsButton',
    buttonLink: leadGenerationUrl,
  },
  {
    heading: 'footerCtaWorkflowHeading',
    body: 'footerCtaWorkflowBody',
    buttonText: 'footerCtaWorkflowButton',
    buttonLink: dataEnrichmentUrl,
  },
]

const attributeKeys = [
  'phone',
  'skype',
  'whatsapp',
  'email',
  'verifiedEmail',
  'safeEmail',
  'twitter',
  'facebook',
  'instagram',
  'github',
  'tiktok',
  'youtube',
  'pinterest',
  'linkedin',
  'owler',
  'title',
  'description',
  'copyright',
  'copyrightYear',
  'responsive',
  'schemaOrgTypes',
  'certInfo.subjectOrg',
  'certInfo.subjectCountry',
  'certInfo.subjectState',
  'certInfo.subjectLocality',
  'certInfo.issuer',
  'certInfo.protocol',
  'certInfo.validTo',
  'dns.spf',
  'dns.dmarc',
  'trackerGoogleAnalytics',
  'trackerGoogleAdSense',
  'trackerMedianet',
  'trackerFacebook',
  'trackerOptimizely',
  'companyName',
  'inferredCompanyName',
  'industry',
  'about',
  'locations',
  'companySize',
  'companyType',
  'companyFounded',
  'employees',
]

function setDisabledDomain(enabled) {
  Popup.domainDisabled = enabled
  const el = {
    headerSwitchEnabled: document.querySelector('.header__switch--enabled'),
    headerSwitchDisabled: document.querySelector('.header__switch--disabled'),
  }

  if (enabled) {
    el.headerSwitchEnabled.classList.add('header__switch--hidden')
    el.headerSwitchDisabled.classList.remove('header__switch--hidden')
  } else {
    el.headerSwitchEnabled.classList.remove('header__switch--hidden')
    el.headerSwitchDisabled.classList.add('header__switch--hidden')
  }
}

function getMessage(name, substitutions) {
  return chrome.i18n.getMessage(name, substitutions)
}

function getCsv() {
  let hostname = ''
  let www = false

  try {
    ;({ hostname } = new URL(Popup.cache.url))

    www = hostname.startsWith('www')

    hostname = hostname.replace(/^www\./, '')
  } catch (error) {
    // Continue
  }

  const columns = [
    'URL',
    ...Popup.cache.categories.map(({ id }) =>
      chrome.i18n.getMessage(`categoryName${id}`)
    ),
    ...attributeKeys.map((key) =>
      chrome.i18n.getMessage(
        `attribute${
          key.charAt(0).toUpperCase() + key.slice(1).replace('.', '_')
        }`
      )
    ),
  ]

  const csv = [`"${columns.join('","')}"`]

  const filename = `wappalyzer${
    hostname ? `_${hostname.replace('.', '-')}` : ''
  }.csv`

  const row = [`https://${www ? 'www.' : ''}${hostname}`]

  row.push(
    ...Popup.cache.categories.reduce((categories, { id }) => {
      categories.push(
        Popup.cache.detections
          .filter(({ categories }) =>
            categories.some(({ id: _id }) => _id === id)
          )
          .map(({ name }) => name)
          .join(' ; ')
      )

      return categories
    }, [])
  )

  row.push(
    ...attributeKeys.map((key) => csvEscape(Popup.cache.attributeValues[key]))
  )

  csv.push(`"${row.join('","')}"`)

  return { csv, filename }
}

function csvEscape(value = '') {
  if (Array.isArray(value)) {
    value = value
      .flat()
      .slice(0, 10)
      .map((value) => csvEscape(String(value).replace(/ ; /g, ' : ')))
      .join(' ; ')
  }

  if (typeof value === 'string') {
    return value.replace(/\n/g, ' ').replace(/"/g, '""').trim()
  }

  if (typeof value === 'boolean') {
    return String(value).toUpperCase()
  }

  if (value === null) {
    return ''
  }

  return String(value).replace(/"/g, '""')
}

function parseEmail(fullEmail) {
  const email = fullEmail.replace(/^[^<]*<([^>]+)>/, '$1')

  const [name, title] = fullEmail.replace(/ <([^>]+)>$/, '').split(' -- ')

  return { email, name, title }
}

function getTechnologySpend(technologies) {
  const totals = technologies.reduce(
    (totals, { pricing }) => {
      pricing.forEach((price) => totals[price]++)

      return totals
    },
    { low: 0, poa: 0, mid: 0, high: 0 }
  )

  totals.mid += Math.floor(totals.low / 3)
  totals.high += Math.floor(totals.poa / 2)
  totals.high += Math.floor(totals.mid / 3)
  totals.xhigh = Math.floor(totals.high / 3)

  const spend = totals.xhigh
    ? getMessage('spendVeryHigh')
    : totals.high
    ? getMessage('spendHigh')
    : totals.mid
    ? getMessage('spendMedium')
    : totals.low
    ? getMessage('spendLow')
    : getMessage('spendVeryLow')

  return spend
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isLocalDevelopmentUrl(url) {
  if (!/^https?:/i.test(String(url || ''))) {
    return false
  }

  try {
    const { hostname } = new URL(url)

    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.test') ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
      (/^\[?[a-f0-9:]+\]?$/i.test(hostname) && hostname.includes(':'))
    )
  } catch {
    return false
  }
}

const Popup = {
  async openSettings() {
    if (
      agent === 'firefox' &&
      (await chrome.runtime.getPlatformInfo()).os === 'android'
    ) {
      // Android's embedded extension view does not navigate on openOptionsPage.
      window.location.assign(chrome.runtime.getURL('html/options.html'))
      return
    }

    try {
      if (typeof chrome.runtime.openOptionsPage === 'function') {
        await chrome.runtime.openOptionsPage()

        return
      }
    } catch {
      // Continue with the bundled options page fallback.
    }

    open(chrome.runtime.getURL('html/options.html'))
  },

  /**
   * Initialise popup
   */
  async init() {
    if (
      agent === 'firefox' &&
      (await chrome.runtime.getPlatformInfo()).os === 'android'
    ) {
      document.body.classList.add('body__popup--android')
    }

    await Utils.initDataConsent()

    Popup.cache = {
      tabId: null,
      url: '',
      categories: [],
      detections: [],
      attributeValues: {},
    }

    const el = {
      body: document.body,
      popup: document.querySelector('.popup'),
      detections: document.querySelector('.detections'),
      empty: document.querySelector('.empty'),
      emptyReload: document.querySelector('.empty__reload'),
      footer: document.querySelector('.footer'),
      headerSwitchDisabled: document.querySelector('.header__switch--disabled'),
      headerSwitchEnabled: document.querySelector('.header__switch--enabled'),
      headerSwitches: document.querySelectorAll('.header__switch'),
      plusDownloadLink: document.querySelector(
        '.plus-download__button .button__link'
      ),
      plusConfigureApiKey: document.querySelector('.plus-configure__apikey'),
      plusConfigureSave: document.querySelector('.plus-configure__save'),
      plusDownload: document.querySelector('.plus-download'),
      tabPlus: document.querySelector('.tab--plus'),
      terms: document.querySelector('.terms'),
      termsButtonAccept: document.querySelector('.terms__button--accept'),
      termsButtonDecline: document.querySelector('.terms__button--decline'),
      termsPrivacyOther: document.querySelector('.terms__privacy--other'),
      termsPrivacyFirefox: document.querySelector('.terms__privacy--firefox'),
      footerButtonLink: document.querySelector('.footer .button__link'),
      footerButtonText: document.querySelector('.footer .button__text'),
      footerContentBody: document.querySelector('.footer__content-body'),
      footerHeading: document.querySelector('.footer__heading'),
      footerHeadingText: document.querySelector('.footer__heading-text'),
      footerToggleClose: document.querySelector('.footer__toggle--close'),
      footerToggleOpen: document.querySelector('.footer__toggle--open'),
      headerSettings: document.querySelector('.header__settings'),
      headerThemeDark: document.querySelector('.header__theme--dark'),
      headerThemeLight: document.querySelector('.header__theme--light'),
      headerThemes: document.querySelectorAll('.header__theme'),
      issue: document.querySelector('.issue'),
      tabItems: document.querySelectorAll('.tab-item'),
      tabs: document.querySelectorAll('.tab'),
      templates: document.querySelectorAll('[data-template]'),
    }

    Popup.elements = el

    // Templates
    Popup.templates = Array.from(el.templates).reduce((templates, template) => {
      templates[template.dataset.template] = template.cloneNode(true)

      template.remove()

      return templates
    }, {})

    // Disabled domains
    const dynamicIcon = await getOption('dynamicIcon', false)

    if (dynamicIcon) {
      el.body.classList.add('dynamic-icon')
    }

    // Disabled domains
    let disabledDomains = await getOption('disabledDomains', [])

    // Dark mode
    const theme = await getOption('theme', 'light')

    if (theme === 'dark') {
      el.body.classList.add('dark')
      el.headerThemeLight.classList.remove('header__icon--hidden')
      el.headerThemeDark.classList.add('header__icon--hidden')
    }

    // Privacy policy
    if (agent === 'firefox') {
      el.termsPrivacyOther.classList.add('terms__privacy--hidden')
      el.termsPrivacyFirefox.classList.remove('terms__privacy--hidden')
    }

    // Terms
    let termsAccepted =
      agent === 'chrome' || (await getOption('termsAccepted', false))
    let plusSupported = false

    const syncPlusTabState = () => {
      el.tabPlus.classList[termsAccepted && plusSupported ? 'remove' : 'add'](
        'tab--disabled'
      )
    }

    syncPlusTabState()

    if (termsAccepted) {
      el.terms.classList.add('terms--hidden')
    } else {
      el.terms.classList.remove('terms--hidden')
      Popup.setDetectionStatus()
      Popup.setDetectionLoading(false)
      document.querySelector('.detection-region').hidden = true
      el.empty.classList.add('empty--hidden')
      el.detections.classList.add('detections--hidden')
      el.issue.classList.add('issue--hidden')
      el.footer.classList.add('footer--hidden')
      syncPlusTabState()

      el.termsButtonAccept.addEventListener('click', async () => {
        const granted = await Utils.requestDataPermissions(
          Utils.trackingDataPermissions
        )
        await setOption('termsAccepted', true)
        await setOption('tracking', granted)
        termsAccepted = true

        el.terms.classList.add('terms--hidden')
        el.footer.classList.remove('footer--hidden')
        syncPlusTabState()

        Popup.startDetections()
      })

      el.termsButtonDecline.addEventListener('click', async () => {
        await setOption('termsAccepted', true)
        await setOption('tracking', false)
        termsAccepted = true

        el.terms.classList.add('terms--hidden')
        el.footer.classList.remove('footer--hidden')
        syncPlusTabState()

        Popup.startDetections()
      })
    }

    let url

    const tabs = await promisify(chrome.tabs, 'query', {
      active: true,
      currentWindow: true,
    })

    if (tabs && tabs.length) {
      ;[{ id: Popup.cache.tabId, url }] = tabs

      if (url.startsWith('http')) {
        Popup.cache.url = url

        const { hostname } = new URL(url)
        plusSupported = !isLocalDevelopmentUrl(url)

        syncPlusTabState()

        setDisabledDomain(disabledDomains.includes(hostname))

        el.headerSwitchDisabled.addEventListener('click', async () => {
          disabledDomains = disabledDomains.filter(
            (_hostname) => _hostname !== hostname
          )

          await setOption('disabledDomains', disabledDomains)

          setDisabledDomain(false)

          Popup.startDetections()
        })

        el.headerSwitchEnabled.addEventListener('click', async () => {
          disabledDomains.push(hostname)

          await setOption('disabledDomains', disabledDomains)

          setDisabledDomain(true)

          Popup.startDetections()
        })
      } else {
        for (const headerSwitch of el.headerSwitches) {
          headerSwitch.classList.add('header__switch--hidden')
        }

        plusSupported = false
        syncPlusTabState()
      }
    }

    if (termsAccepted) {
      Popup.startDetections()
    }

    // Plus configuration
    el.plusConfigureApiKey.value = await getOption('apiKey', '')
    document.querySelector('.plus-connect').open =
      !!el.plusConfigureApiKey.value
    document
      .querySelector('.plus-connect')
      .addEventListener('toggle', (event) => {
        if (event.target.open) {
          document
            .querySelector('.plus-configure__form')
            .scrollIntoView({ block: 'nearest' })
        }
      })

    document
      .querySelector('.plus-configure__form')
      .addEventListener('submit', async (event) => {
        event.preventDefault()
        const status = document.querySelector('.plus-key-status')
        const apiKey = el.plusConfigureApiKey.value.trim()
        if (!apiKey) {
          status.textContent = getMessage('plusKeyEmpty')
          el.plusConfigureApiKey.focus()
          return
        }
        if (el.plusConfigureSave.disabled) {
          return
        }
        el.plusConfigureSave.disabled = true
        status.textContent = getMessage('plusConnectSaving')
        try {
          if (
            !(await Utils.requestDataPermissions(Utils.plusDataPermissions))
          ) {
            status.textContent = getMessage('plusDataPermissionRequired')
            return
          }
          await promisify(chrome.storage.local, 'set', {
            apiKey,
            apiKeyUpdatedAt: Date.now(),
          })
          status.textContent = getMessage('plusConnectSaved')
          await Popup.getPlus(url)
        } catch {
          status.textContent = getMessage('plusConnectSaveFailed')
        } finally {
          el.plusConfigureSave.disabled = false
        }
      })

    // Header
    el.headerSettings.addEventListener('click', Popup.openSettings)

    // Theme
    el.headerThemes.forEach((headerTheme) =>
      headerTheme.addEventListener('click', async () => {
        const theme = await getOption('theme', 'light')

        el.body.classList[theme === 'dark' ? 'remove' : 'add']('dark')
        el.body.classList[theme === 'dark' ? 'add' : 'remove']('light')
        el.headerThemeDark.classList[theme === 'dark' ? 'remove' : 'add'](
          'header__icon--hidden'
        )
        el.headerThemeLight.classList[theme === 'dark' ? 'add' : 'remove'](
          'header__icon--hidden'
        )

        await setOption('theme', theme === 'dark' ? 'light' : 'dark')
      })
    )

    // Tabs
    el.tabs.forEach((tab, index) => {
      tab.addEventListener('click', async () => {
        if (
          tab.classList.contains('tab--plus') &&
          !(await Utils.requestDataPermissions(Utils.plusDataPermissions))
        ) {
          return
        }
        el.tabs.forEach((tab) => tab.classList.remove('tab--active'))
        el.tabItems.forEach((item) => item.classList.add('tab-item--hidden'))

        tab.classList.add('tab--active')
        el.tabItems[index].classList.remove('tab-item--hidden')
        el.popup.scrollTop = 0

        el.plusDownload.classList.remove('plus-download--hidden')
        el.footer.classList.remove('footer--hidden')

        Popup.plusActive = tab.classList.contains('tab--plus')
        if (Popup.plusActive) {
          await Popup.getPlus(url)
        }
      })
    })

    // Download
    el.plusDownloadLink.addEventListener('click', Popup.downloadCsv)

    // Footer
    const item = footers[Math.floor(Math.random() * footers.length)]

    el.footerHeadingText.textContent = getMessage(item.heading)
    el.footerContentBody.textContent = getMessage(item.body)
    el.footerButtonText.textContent = getMessage(item.buttonText)
    el.footerButtonLink.href = item.buttonLink

    const collapseFooter = await getOption('collapseFooter', false)

    if (collapseFooter) {
      el.footer.classList.add('footer--collapsed')
      el.footerToggleClose.classList.add('footer__toggle--hidden')
      el.footerToggleOpen.classList.remove('footer__toggle--hidden')
    }

    el.footerHeading.setAttribute('aria-expanded', String(!collapseFooter))

    el.footerHeading.addEventListener('click', async () => {
      const collapsed = el.footer.classList.contains('footer--collapsed')

      el.footer.classList[collapsed ? 'remove' : 'add']('footer--collapsed')
      el.footerToggleClose.classList[collapsed ? 'remove' : 'add'](
        'footer__toggle--hidden'
      )
      el.footerToggleOpen.classList[collapsed ? 'add' : 'remove'](
        'footer__toggle--hidden'
      )

      el.footerHeading.setAttribute('aria-expanded', String(collapsed))
      await setOption('collapseFooter', !collapsed)
    })

    Array.from(document.querySelectorAll('a[href^="http"]')).forEach((a) => {
      a.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopImmediatePropagation()

        const { version } = chrome.runtime.getManifest()

        open(a.href.replace(/__URL__/g, url).replace(/__VERSION__/g, version))

        return false
      })
    })

    // Reload
    el.emptyReload.addEventListener('click', Popup.reloadPage)

    // Apply internationalization
    i18n()

    const controls = [
      [el.headerSwitchEnabled, 'disableOnDomain'],
      [el.headerSwitchDisabled, 'enableOnDomain'],
      [el.headerSettings, 'options'],
      [el.headerThemeDark, 'themeUseDark'],
      [el.headerThemeLight, 'themeUseLight'],
    ]
    controls.forEach(([control, key]) => {
      const label = getMessage(key)
      control.setAttribute('aria-label', label)
      let title = control.querySelector('title')
      if (!title) {
        title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
        control.prepend(title)
      }
      title.textContent = label
    })
    ;[...controls.map(([control]) => control), el.footerHeading].forEach(
      (control) => {
        control.setAttribute('role', 'button')
        control.setAttribute('tabindex', '0')
        control.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            control.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          }
        })
      }
    )

    Popup.cache.categories = await Popup.driver('getCategories')
  },

  showNoResults(message = 'detectionsNoneYet') {
    if (Popup.detectionsStopped || Popup.hasVisibleDetections) {
      return
    }
    clearTimeout(Popup.skeletonTimer)
    Popup.skeletonExpired = true
    const unsupported = !/^https?:/i.test(Popup.cache?.url || '')
    const disabled = Popup.domainDisabled
    Popup.setDetectionLoading(false)
    Popup.setDetectionStatus()
    const label = document.querySelector('.empty__message')
    label.removeAttribute('data-i18n')
    label.textContent = getMessage(
      disabled
        ? 'detectionsDisabled'
        : unsupported
        ? 'detectionsUnsupported'
        : message
    )
    document.querySelector('.empty').classList.remove('empty--hidden')
    document.querySelector('.detections').classList.add('detections--hidden')
    document.querySelector('.issue').classList.add('issue--hidden')
    document.querySelector('.empty__reload').hidden = disabled || unsupported
  },

  beginDetectionWait() {
    clearTimeout(Popup.skeletonTimer)
    Popup.skeletonExpired = false
    Popup.setDetectionStatus()
    if (!Popup.hasVisibleDetections) {
      document.querySelector('.empty').classList.add('empty--hidden')
      Popup.setDetectionLoading(true)
    }
    Popup.skeletonTimer = setTimeout(() => {
      Popup.skeletonExpired = true
      Popup.showNoResults()
    }, 2000)
  },

  async reloadPage(event) {
    event.preventDefault()
    const button = document.querySelector('.empty__reload')
    if (button.disabled) {
      return
    }
    button.disabled = true
    try {
      await promisify(chrome.tabs, 'reload', Popup.cache.tabId, {})
      Popup.detectionSignature = null
      Popup.hasFreshDetections = false
      Popup.beginDetectionWait()
      Popup.refreshDetections()
    } catch {
      Popup.showNoResults('detectionsReloadFailed')
    } finally {
      button.disabled = false
    }
  },

  setDetectionLoading(loading) {
    const skeleton = document.querySelector('.detection-skeleton')
    skeleton.hidden = !loading
    skeleton.setAttribute('aria-label', getMessage('detectionsLoading'))
  },

  setDetectionStatus(key) {
    const status = document.querySelector('.detection-status')
    status.removeAttribute('data-i18n')
    status.textContent = key ? getMessage(key) : ''
    status.hidden = !key
  },

  startDetections() {
    document.querySelector('.detection-region').hidden = false
    if (!Popup.detectionsStarted) {
      Popup.detectionsStarted = true
      Popup.renderQueue = Promise.resolve()
      Popup.beginDetectionWait()
      Popup.driver('getPopupCache')
        .then((detections) => {
          if (Array.isArray(detections) && detections.length) {
            return Popup.renderDetections(detections, true)
          }
        })
        .catch(() => {}) // The full response remains authoritative.
      window.addEventListener('pagehide', () => {
        Popup.detectionsStopped = true
        clearTimeout(Popup.detectionsTimer)
        clearTimeout(Popup.skeletonTimer)
      })
    }

    Popup.refreshDetections()
  },

  renderDetections(detections, cached = false) {
    Popup.renderQueue = Popup.renderQueue
      .catch(() => {})
      .then(async () => {
        if (Popup.detectionsStopped || (cached && Popup.hasFreshDetections)) {
          return
        }

        const visible = detections.some(
          (detection) =>
            detection?.confidence >= 50 &&
            detection.slug !== 'cart-functionality'
        )
        if (cached && !visible) {
          return
        }
        if (!cached) {
          Popup.hasFreshDetections = true
        }
        Popup.hasVisibleDetections = visible
        clearTimeout(Popup.skeletonTimer)

        const signature = JSON.stringify(detections)

        if (signature !== Popup.detectionSignature) {
          await Popup.onGetDetections(detections)
          Popup.detectionSignature = signature
        }

        if (!visible) {
          Popup.showNoResults('noAppsDetected')
        }
        Popup.setDetectionLoading(false)
        Popup.setDetectionStatus()
      })

    return Popup.renderQueue
  },

  async refreshDetections() {
    if (Popup.detectionsBusy || Popup.detectionsStopped) {
      return
    }

    clearTimeout(Popup.detectionsTimer)
    Popup.detectionsBusy = true

    try {
      const response = await Popup.driver('getDetections', [true])
      const { detections, scanComplete } = response || {}
      if (!Array.isArray(detections)) {
        throw new TypeError('Missing detection response')
      }
      const visible = detections.filter(
        (detection) =>
          detection?.confidence >= 50 && detection.slug !== 'cart-functionality'
      )
      if (visible.length || scanComplete) {
        await Popup.renderDetections(detections)
      } else if (Popup.skeletonExpired) {
        Popup.showNoResults()
      }
    } catch {
      Popup.setDetectionLoading(false)
      if (Popup.hasVisibleDetections) {
        Popup.setDetectionStatus('detectionsLoadFailed')
      } else {
        Popup.showNoResults('detectionsLoadFailed')
      }
    } finally {
      Popup.detectionsBusy = false

      if (!Popup.detectionsStopped) {
        Popup.detectionsTimer = setTimeout(Popup.refreshDetections, 1000)
      }
    }
  },

  driver(func, args) {
    return sendMessage('popup.js', func, args)
  },

  /**
   * Log debug messages to the console
   * @param {String} message
   */
  log(message) {
    Popup.driver('log', message)
  },

  /**
   * Group technologies into categories
   * @param {Object} technologies
   */
  categorise(technologies) {
    return Object.values(
      technologies
        .filter(({ confidence }) => confidence >= 50)
        .reduce((categories, technology) => {
          technology.categories.forEach((category) => {
            categories[category.id] = categories[category.id] || {
              ...category,
              technologies: [],
            }

            categories[category.id].technologies.push(technology)
          })

          return categories
        }, {})
    )
  },

  /**
   * Callback for getDetection listener
   * @param {Array} detections
   */
  async onGetDetections(detections = []) {
    Popup.cache.detections = detections

    const el = {
      empty: document.querySelector('.empty'),
      detections: document.querySelector('.detections'),
      issue: document.querySelector('.issue'),
      plusDownload: document.querySelector('.plus-download'),
    }

    detections = (detections || [])
      .filter(({ confidence }) => confidence >= 50)
      .filter(({ slug }) => slug !== 'cart-functionality')

    if (!detections || !detections.length) {
      Popup.showNoResults('noAppsDetected')
      if (!Popup.plusActive) {
        el.plusDownload.classList.add('plus-download--hidden')
      }

      return
    }

    el.empty.classList.add('empty--hidden')
    el.detections.classList.remove('detections--hidden')
    el.issue.classList.remove('issue--hidden')
    if (!Popup.plusActive) {
      el.plusDownload.classList.remove('plus-download--hidden')
    }

    let firstChild

    while ((firstChild = el.detections.firstChild)) {
      if (firstChild instanceof Node) {
        el.detections.removeChild(firstChild)
      }
    }

    const pinnedCategory = await getOption('pinnedCategory')

    const categorised = Popup.categorise(detections)

    categorised.forEach(({ id, name, slug: categorySlug, technologies }) => {
      const categoryNode = Popup.templates.category.cloneNode(true)

      const el = {
        detections: document.querySelector('.detections'),
        link: categoryNode.querySelector('.category__link'),
        pins: categoryNode.querySelectorAll('.category__pin'),
        pinsActive: document.querySelectorAll('.category__pin--active'),
      }

      el.link.href = `https://www.wappalyzer.com/technologies/${categorySlug}/?utm_source=popup&utm_medium=extension&utm_campaign=wappalyzer`
      el.link.dataset.i18n = `categoryName${id}`

      if (pinnedCategory === id) {
        el.pins.forEach((pin) => pin.classList.add('category__pin--active'))
      }

      el.pins.forEach((pin) =>
        pin.addEventListener('click', async () => {
          const pinnedCategory = await getOption('pinnedCategory')

          el.pinsActive.forEach((pin) =>
            pin.classList.remove('category__pin--active')
          )

          if (pinnedCategory === id) {
            await setOption('pinnedCategory', null)
          } else {
            await setOption('pinnedCategory', id)

            el.pins.forEach((pin) => pin.classList.add('category__pin--active'))
          }
        })
      )

      technologies.forEach(
        ({ name, slug, confidence, version, icon, website }) => {
          const technologyNode = Popup.templates.technology.cloneNode(true)

          const el = {
            technologies: categoryNode.querySelector('.technologies'),
            iconImage: technologyNode.querySelector('.technology__icon img'),
            link: technologyNode.querySelector('.technology__link'),
            name: technologyNode.querySelector('.technology__name'),
            version: technologyNode.querySelector('.technology__version'),
            confidence: technologyNode.querySelector('.technology__confidence'),
          }

          el.iconImage.src = `../images/icons/${icon}`

          el.link.href = `https://www.wappalyzer.com/technologies/${categorySlug}/${slug}/?utm_source=popup&utm_medium=extension&utm_campaign=wappalyzer`
          el.name.textContent = name

          if (confidence < 100) {
            el.confidence.textContent = getMessage(
              'confidenceSure',
              String(confidence)
            )
          } else {
            el.confidence.remove()
          }

          if (version) {
            el.version.textContent = version
          } else {
            el.version.remove()
          }

          el.technologies.appendChild(technologyNode)
        }
      )

      el.detections.appendChild(categoryNode)
    })

    if (categorised.length === 1) {
      el.detections.appendChild(Popup.templates.category.cloneNode(true))
    }

    Popup.boundLinks = Popup.boundLinks || new WeakSet()
    Array.from(document.querySelectorAll('a'))
      .filter((a) => {
        if (Popup.boundLinks.has(a)) {
          return false
        }
        Popup.boundLinks.add(a)
        return true
      })
      .forEach((a) =>
        a.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopImmediatePropagation()

          open(a.href)

          return false
        })
      )

    i18n()
  },

  /**
   * Show company and contact details
   * @param {String} url
   */
  async getPlus(url) {
    const apiKey = await getOption('apiKey', '')
    const apiKeyUpdatedAt = parseInt(await getOption('apiKeyUpdatedAt', 0), 10)

    const el = {
      loading: document.querySelector('.loading'),
      panels: document.querySelector('.panels'),
      empty: document.querySelector('.plus-empty'),
      crawl: document.querySelector('.plus-crawl'),
      error: document.querySelector('.plus-error'),
      download: document.querySelector('.plus-download'),
      errorMessage: document.querySelector('.plus-error__message'),
      configure: document.querySelector('.plus-configure'),
      footer: document.querySelector('.footer'),
    }

    el.error.classList.add('plus-error--hidden')
    el.download.classList.add('plus-download--hidden')

    if (apiKey) {
      el.loading.classList.remove('loading--hidden')
      el.configure.classList.add('plus-configure--hidden')
      el.footer.classList.remove('footer--hidden')
    } else {
      el.loading.classList.add('loading--hidden')
      el.configure.classList.remove('plus-configure--hidden')
      el.footer.classList.add('footer--hidden')

      return
    }

    el.panels.classList.add('panels--hidden')
    el.empty.classList.add('plus-empty--hidden')
    el.crawl.classList.add('plus-crawl--hidden')
    el.error.classList.add('plus-error--hidden')

    let lastChild

    while ((lastChild = el.panels.lastElementChild)) {
      if (lastChild instanceof Node) {
        el.panels.removeChild(lastChild)
      }
    }

    try {
      let data
      let response

      for (let attempt = 0; ; attempt += 1) {
        if (!(await Utils.hasDataPermissions(Utils.plusDataPermissions))) {
          throw new Error(getMessage('plusDataPermissionRequired'))
        }
        response = await fetch(
          `https://api.wappalyzer.com/v2/plus/${encodeURIComponent(url)}`,
          {
            method: 'GET',
            headers: {
              'x-api-key': apiKey,
            },
          }
        )

        data = await response.json()

        if (response.ok) {
          await setOption('apiKeyUpdatedAt', 0)

          break
        }

        const recentApiKey =
          apiKeyUpdatedAt &&
          Date.now() - apiKeyUpdatedAt < apiKeyActivationWindow &&
          [403, 429].includes(response.status)

        if (!recentApiKey || attempt >= apiKeyRetryDelays.length) {
          const error = new Error()

          error.data = data
          error.response = response
          error.apiKeyPendingActivation = recentApiKey

          throw error
        }

        await delay(apiKeyRetryDelays[attempt])
      }

      const { attributes, crawl } = data

      if (Popup.cache.detections.length) {
        attributes.signals = attributes.signals || []

        attributes.signals.technologySpend = getTechnologySpend(
          Popup.cache.detections
        )
      }

      if (crawl) {
        document
          .querySelector('.plus-crawl')
          .classList.remove('plus-crawl--hidden')

        return
      }

      if (!Object.keys(attributes).length) {
        el.empty.classList.remove('plus-empty--hidden')
        el.download.classList.remove('plus-download--hidden')

        return
      }

      const attributeValues = {}

      Object.keys(attributes).forEach((set) => {
        const panel = document.createElement('div')
        const header = document.createElement('div')
        const content = document.createElement('div')
        const table = document.createElement('table')

        panel.classList.add('panel')
        header.classList.add('panel__header')
        content.classList.add('panel__content')

        header.setAttribute(
          'data-i18n',
          `set${set.charAt(0).toUpperCase() + set.slice(1)}`
        )

        Object.keys(attributes[set]).forEach((key) => {
          const value = attributes[set][key]

          const tr = document.createElement('tr')

          const th = document.createElement('th')
          const td = document.createElement('td')

          th.setAttribute(
            'data-i18n',
            `attribute${
              key.charAt(0).toUpperCase() + key.slice(1).replace('.', '_')
            }`
          )

          attributeValues[key] = []

          if (Array.isArray(value)) {
            value.forEach((value) => {
              const div = document.createElement('div')

              if (typeof value === 'object') {
                attributeValues[key].push(value.text)

                const a = document.createElement('a')

                a.href = value.to
                a.textContent = value.text

                if (key === 'keywords') {
                  a.style = 'padding-right: .3rem;'

                  const space = document.createTextNode(' ')

                  td.append(a, space)
                } else if (
                  ['email', 'verifiedEmail', 'safeEmail'].includes(key)
                ) {
                  const { email, name, title } = parseEmail(value.text)

                  a.textContent = email

                  const div = document.createElement('div')
                  const elName = document.createElement('span')
                  const elTitle = document.createElement('span')
                  const elBreak1 = document.createElement('br')
                  const elBreak2 = document.createElement('br')

                  elName.textContent = name
                  elTitle.textContent = `${title}`

                  elTitle.className = 'light-text'

                  div.append(a)

                  if (name && name !== email) {
                    div.appendChild(elBreak1)
                    div.appendChild(elName)

                    if (title) {
                      div.appendChild(elBreak2)
                      div.appendChild(elTitle)
                    }
                  }

                  td.append(div)
                } else {
                  div.appendChild(a)
                  td.appendChild(div)
                }
              } else if (key === 'employees') {
                attributeValues[key].push(value)

                const [name, title] = value.split(' -- ')

                const elName = document.createElement('span')
                const elTitle = document.createElement('span')
                const elBreak = document.createElement('br')

                elTitle.className = 'light-text'

                elName.textContent = name
                elTitle.textContent = title

                div.appendChild(elName)
                div.appendChild(elBreak)
                div.appendChild(elTitle)
                td.appendChild(div)
              } else {
                attributeValues[key].push(value)

                div.textContent = value
                td.appendChild(div)
              }
            })
          } else if (key === 'companyName') {
            attributeValues[key].push(value)

            const strong = document.createElement('strong')

            strong.textContent = value

            td.appendChild(strong)
          } else {
            attributeValues[key].push(value)

            td.textContent = value
          }

          if (key !== 'keywords') {
            tr.appendChild(th)
          }

          tr.appendChild(td)
          table.appendChild(tr)
        })

        content.appendChild(table)

        panel.appendChild(header)
        panel.appendChild(content)
        el.panels.appendChild(panel)
      })

      Popup.cache.attributeValues = attributeValues

      el.panels.classList.remove('panels--hidden')
      el.download.classList.remove('plus-download--hidden')
      el.loading.classList.add('loading--hidden')
    } catch (error) {
      Popup.log(error.data)

      // eslint-disable-next-line
      console.log(error)

      el.errorMessage.textContent = error.response
        ? getMessage('plusErrorStatus', String(error.response.status))
        : getMessage('plusErrorGeneric')

      if (error.response) {
        if (error.apiKeyPendingActivation) {
          el.errorMessage.textContent = getMessage('apiKeyPendingActivation')
        } else if (error.response.status === 403) {
          el.errorMessage.textContent =
            typeof error.data === 'string'
              ? error.data
              : getMessage('plusErrorNoAccess')

          el.configure.classList.remove('plus-configure--hidden')
          document.querySelector('.plus-connect').open = true
        } else if (error.response.status === 429) {
          el.errorMessage.textContent = getMessage('plusErrorTooManyRequests')
        } else if (
          error.response.status === 400 &&
          typeof error.data === 'string'
        ) {
          el.errorMessage.textContent = error.data
        }
      }

      el.loading.classList.add('loading--hidden')
      el.error.classList.remove('plus-error--hidden')
    }

    Array.from(document.querySelectorAll('.panels a')).forEach((a) =>
      a.addEventListener('click', (event) => {
        event.preventDefault()

        open(a.href)

        return false
      })
    )

    i18n()
  },

  async downloadCsv(event) {
    event.preventDefault()

    const { csv, filename } = getCsv()

    const file = URL.createObjectURL(
      new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8' })
    )

    const granted = await promisify(chrome.permissions, 'request', {
      permissions: ['downloads'],
    })

    if (granted) {
      chrome.downloads.download({
        url: file,
        filename,
      })
    }

    return false
  },
}

if (/complete|interactive|loaded/.test(document.readyState)) {
  Popup.init()
} else {
  document.addEventListener('DOMContentLoaded', Popup.init)
}
