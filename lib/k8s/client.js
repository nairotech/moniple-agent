// ============================================================================
// KUBERNETES CLIENT
// ============================================================================
// Sole owner of the lazily-initialized API client handles. Consumers MUST
// access them via the getter functions below (never capture them at import
// time, since they are null until initKubernetesClient() runs).

const k8s = require("@kubernetes/client-node");

let kc = null;
let k8sAppsApi = null;
let k8sCoreApi = null;
let k8sRbacApi = null;
let k8sBatchApi = null;
let k8sStorageApi = null;
let k8sAuthApi = null;

function initKubernetesClient() {
  try {
    kc = new k8s.KubeConfig();
    // Try in-cluster config first, fallback to default kubeconfig
    try {
      kc.loadFromCluster();
      console.log("Loaded in-cluster Kubernetes config");
    } catch (e) {
      kc.loadFromDefault();
      console.log("Loaded default Kubernetes config");
    }
    k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
    k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
    k8sRbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);
    k8sStorageApi = kc.makeApiClient(k8s.StorageV1Api);
    // SelfSubjectAccessReview: lets the agent ask the API server what it may
    // do instead of learning its own permissions from 403 errors.
    k8sAuthApi = kc.makeApiClient(k8s.AuthorizationV1Api);
    return true;
  } catch (error) {
    console.error("Failed to initialize Kubernetes client:", error.message);
    return false;
  }
}

module.exports = {
  initKubernetesClient,
  getKubeConfig: () => kc,
  getCoreApi: () => k8sCoreApi,
  getAppsApi: () => k8sAppsApi,
  getRbacApi: () => k8sRbacApi,
  getBatchApi: () => k8sBatchApi,
  getStorageApi: () => k8sStorageApi,
  getAuthApi: () => k8sAuthApi,
};
