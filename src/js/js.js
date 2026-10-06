/* eslint-env browser */

;(function () {
  const script = document.currentScript
  let detections = []

  try {
    if (!script) {
      return
    }

    const { technologies = [] } = JSON.parse(script.dataset.wappalyzer || '{}')

    detections = technologies.reduce((technologies, { name, chains }) => {
      if (chains) {
        chains.forEach((chain) => {
          const value = chain
            .split('.')
            .reduce(
              (value, method) =>
                value &&
                value instanceof Object &&
                Object.prototype.hasOwnProperty.call(value, method)
                  ? value[method]
                  : '__UNDEFINED__',
              window
            )

          if (value !== '__UNDEFINED__') {
            technologies.push({
              name,
              chain,
              value:
                typeof value === 'string' || typeof value === 'number'
                  ? value
                  : !!value,
            })
          }
        })
      }

      return technologies
    }, [])
  } catch (e) {
    // Fail quietly
  }

  script.removeAttribute('data-wappalyzer')
  script.dataset.wappalyzerResult = JSON.stringify({ js: detections })
  script.dispatchEvent(new Event('wappalyzer:response'))
})()
