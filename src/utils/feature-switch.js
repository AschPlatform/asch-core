const featureMap = new Map()

module.exports = {
  enable: (feature) => {
    featureMap.set(feature, 1)
  },
  disable: (feature) => {
    featureMap.set(feature, 0)
  },
  isEnabled: feature => featureMap.get(feature),
  copyFeature: (srcFeature, targetFeature) => {
    featureMap.set(targetFeature, featureMap.get(srcFeature))
  },
}
