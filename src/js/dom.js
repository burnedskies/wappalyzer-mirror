/* eslint-env browser */

;(function () {
  const script = document.currentScript
  let detections = []

  try {
    if (!script) {
      return
    }

    const { technologies = [] } = JSON.parse(script.dataset.wappalyzer || '{}')
    const toScalar = (value) =>
      typeof value === 'string' || typeof value === 'number' ? value : !!value

    detections = technologies.reduce((technologies, { name, dom }) => {
      try {
        Object.keys(dom).forEach((selector) => {
          let nodes = []

          try {
            nodes = document.querySelectorAll(selector)
          } catch (error) {
            // Continue
          }

          if (!nodes.length) {
            return
          }

          nodes.forEach((node) => {
            dom[selector].forEach(({ properties }) => {
              if (properties) {
                Object.keys(properties).forEach((property) => {
                  if (Object.prototype.hasOwnProperty.call(node, property)) {
                    const value = node[property]

                    if (typeof value !== 'undefined') {
                      technologies.push({
                        name,
                        selector,
                        property,
                        value: toScalar(value),
                      })
                    }
                  }
                })
              }
            })
          })
        })
      } catch (error) {
        // Fail quietly
      }

      return technologies
    }, [])
  } catch (e) {
    // Fail quietly
  }

  script.removeAttribute('data-wappalyzer')
  script.dataset.wappalyzerResult = JSON.stringify({ dom: detections })
  script.dispatchEvent(new Event('wappalyzer:response'))
})()
