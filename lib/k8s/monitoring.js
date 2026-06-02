// ============================================================================
// AUTO-INSTALL MONITORING STACK
// ============================================================================

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const CONFIG = require("../config");
const k8sClient = require("./client");

async function ensureNamespace(namespace) {
  try {
    await k8sClient.getCoreApi().readNamespace(namespace);
    console.log(`Namespace '${namespace}' already exists`);
    return true;
  } catch (error) {
    if (error.statusCode === 404 || error.response?.statusCode === 404) {
      try {
        await k8sClient.getCoreApi().createNamespace({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: namespace },
        });
        console.log(`Created namespace '${namespace}'`);
        return true;
      } catch (createError) {
        console.error(`Failed to create namespace:`, createError.message);
        return false;
      }
    }
    console.error(`Error checking namespace:`, error.message);
    return false;
  }
}

async function checkDeploymentExists(name, namespace) {
  try {
    await k8sClient.getAppsApi().readNamespacedDeployment(name, namespace);
    return true;
  } catch (error) {
    return false;
  }
}

async function checkDaemonSetExists(name, namespace) {
  try {
    await k8sClient.getAppsApi().readNamespacedDaemonSet(name, namespace);
    return true;
  } catch (error) {
    return false;
  }
}

async function checkClusterRoleExists(name) {
  try {
    await k8sClient.getRbacApi().readClusterRole(name);
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureRbacFromManifest(manifestPath, namespace) {
  // Apply only RBAC resources (ClusterRole, ClusterRoleBinding, ServiceAccount) from manifest
  try {
    const fileContent = fs.readFileSync(manifestPath, "utf8");
    const manifests = yaml.loadAll(fileContent);

    for (const manifest of manifests) {
      if (!manifest) continue;

      const kind = manifest.kind;
      const name = manifest.metadata?.name;

      if (
        !["ClusterRole", "ClusterRoleBinding", "ServiceAccount"].includes(kind)
      ) {
        continue;
      }

      // Override namespace for ServiceAccount
      if (kind === "ServiceAccount" && manifest.metadata) {
        manifest.metadata.namespace = namespace;
      }

      switch (kind) {
        case "ServiceAccount":
          try {
            await k8sClient.getCoreApi().readNamespacedServiceAccount(name, namespace);
          } catch (e) {
            if (e.statusCode === 404 || e.response?.statusCode === 404) {
              await k8sClient.getCoreApi().createNamespacedServiceAccount(
                namespace,
                manifest,
              );
              console.log(`Created ServiceAccount '${name}'`);
            }
          }
          break;

        case "ClusterRole":
          try {
            await k8sClient.getRbacApi().readClusterRole(name);
            await k8sClient.getRbacApi().replaceClusterRole(name, manifest);
            console.log(`Updated ClusterRole '${name}'`);
          } catch (e) {
            try {
              await k8sClient.getRbacApi().createClusterRole(manifest);
              console.log(`Created ClusterRole '${name}'`);
            } catch (createErr) {
              const status =
                createErr.statusCode || createErr.response?.statusCode;
              if (status !== 409) {
                const body = createErr.response?.body || createErr.body || {};
                const detail = body.message || body.reason || "";
                console.error(
                  `Error creating ClusterRole '${name}': status=${status}`,
                  detail,
                );
              }
            }
          }
          break;

        case "ClusterRoleBinding":
          if (manifest.subjects) {
            manifest.subjects.forEach((s) => {
              if (s.namespace) s.namespace = namespace;
            });
          }
          try {
            await k8sClient.getRbacApi().readClusterRoleBinding(name);
            await k8sClient.getRbacApi().replaceClusterRoleBinding(name, manifest);
            console.log(`Updated ClusterRoleBinding '${name}'`);
          } catch (e) {
            try {
              await k8sClient.getRbacApi().createClusterRoleBinding(manifest);
              console.log(`Created ClusterRoleBinding '${name}'`);
            } catch (createErr) {
              const status =
                createErr.statusCode || createErr.response?.statusCode;
              if (status !== 409) {
                const body = createErr.response?.body || createErr.body || {};
                const detail = body.message || body.reason || "";
                console.error(
                  `Error creating ClusterRoleBinding '${name}': status=${status}`,
                  detail,
                );
              }
            }
          }
          break;
      }
    }
  } catch (error) {
    console.error(`Error ensuring RBAC from ${manifestPath}:`, error.message);
  }
}

// Note: checkExistingNodeExporter removed - we always install moniple-node-exporter
// on port 9101 to avoid conflicts with existing node-exporters on port 9100

async function applyManifest(manifestPath, namespace) {
  try {
    const fileContent = fs.readFileSync(manifestPath, "utf8");
    const manifests = yaml.loadAll(fileContent);

    for (const manifest of manifests) {
      if (!manifest) continue;

      // Override namespace
      if (
        manifest.metadata &&
        manifest.kind !== "ClusterRole" &&
        manifest.kind !== "ClusterRoleBinding"
      ) {
        manifest.metadata.namespace = namespace;
      }

      const kind = manifest.kind;
      const name = manifest.metadata?.name;

      try {
        switch (kind) {
          case "Namespace":
            await ensureNamespace(manifest.metadata.name);
            break;

          case "ServiceAccount":
            try {
              await k8sClient.getCoreApi().readNamespacedServiceAccount(name, namespace);
              console.log(`ServiceAccount '${name}' already exists`);
            } catch (e) {
              await k8sClient.getCoreApi().createNamespacedServiceAccount(
                namespace,
                manifest,
              );
              console.log(`Created ServiceAccount '${name}'`);
            }
            break;

          case "ConfigMap":
            try {
              await k8sClient.getCoreApi().readNamespacedConfigMap(name, namespace);
              await k8sClient.getCoreApi().replaceNamespacedConfigMap(
                name,
                namespace,
                manifest,
              );
              console.log(`Updated ConfigMap '${name}'`);
            } catch (e) {
              await k8sClient.getCoreApi().createNamespacedConfigMap(namespace, manifest);
              console.log(`Created ConfigMap '${name}'`);
            }
            break;

          case "Secret":
            try {
              await k8sClient.getCoreApi().readNamespacedSecret(name, namespace);
              console.log(`Secret '${name}' already exists`);
            } catch (e) {
              await k8sClient.getCoreApi().createNamespacedSecret(namespace, manifest);
              console.log(`Created Secret '${name}'`);
            }
            break;

          case "Service":
            try {
              await k8sClient.getCoreApi().readNamespacedService(name, namespace);
              console.log(`Service '${name}' already exists`);
            } catch (e) {
              await k8sClient.getCoreApi().createNamespacedService(namespace, manifest);
              console.log(`Created Service '${name}'`);
            }
            break;

          case "Deployment":
            try {
              await k8sClient.getAppsApi().readNamespacedDeployment(name, namespace);
              console.log(`Deployment '${name}' already exists`);
            } catch (e) {
              await k8sClient.getAppsApi().createNamespacedDeployment(namespace, manifest);
              console.log(`Created Deployment '${name}'`);
            }
            break;

          case "DaemonSet":
            try {
              await k8sClient.getAppsApi().readNamespacedDaemonSet(name, namespace);
              console.log(`DaemonSet '${name}' already exists`);
            } catch (e) {
              await k8sClient.getAppsApi().createNamespacedDaemonSet(namespace, manifest);
              console.log(`Created DaemonSet '${name}'`);
            }
            break;

          case "ClusterRole":
            try {
              await k8sClient.getRbacApi().readClusterRole(name);
              await k8sClient.getRbacApi().replaceClusterRole(name, manifest);
              console.log(`Updated ClusterRole '${name}'`);
            } catch (e) {
              try {
                await k8sClient.getRbacApi().createClusterRole(manifest);
                console.log(`Created ClusterRole '${name}'`);
              } catch (createErr) {
                const status =
                  createErr.statusCode || createErr.response?.statusCode;
                if (status === 409) {
                  console.log(`ClusterRole '${name}' already exists`);
                } else {
                  const body = createErr.response?.body || createErr.body || {};
                  const detail = body.message || body.reason || "";
                  console.error(
                    `Error creating ClusterRole '${name}': status=${status}`,
                    detail,
                  );
                }
              }
            }
            break;

          case "ClusterRoleBinding":
            // Update namespace in subjects
            if (manifest.subjects) {
              manifest.subjects.forEach((s) => {
                if (s.namespace) s.namespace = namespace;
              });
            }
            try {
              await k8sClient.getRbacApi().readClusterRoleBinding(name);
              await k8sClient.getRbacApi().replaceClusterRoleBinding(name, manifest);
              console.log(`Updated ClusterRoleBinding '${name}'`);
            } catch (e) {
              try {
                await k8sClient.getRbacApi().createClusterRoleBinding(manifest);
                console.log(`Created ClusterRoleBinding '${name}'`);
              } catch (createErr) {
                const status =
                  createErr.statusCode || createErr.response?.statusCode;
                if (status === 409) {
                  console.log(`ClusterRoleBinding '${name}' already exists`);
                } else {
                  const body = createErr.response?.body || createErr.body || {};
                  const detail = body.message || body.reason || "";
                  console.error(
                    `Error creating ClusterRoleBinding '${name}': status=${status}`,
                    detail,
                  );
                }
              }
            }
            break;

          default:
            console.log(`Skipping unsupported kind: ${kind}`);
        }
      } catch (applyError) {
        const errorBody = applyError.response?.body || applyError.body || {};
        console.error(`Error applying ${kind} '${name}':`, applyError.message);
        if (errorBody.message) {
          console.error(`  Reason: ${errorBody.message}`);
        }
        if (errorBody.reason) {
          console.error(`  Reason code: ${errorBody.reason}`);
        }
      }
    }
    return true;
  } catch (error) {
    console.error(`Error reading manifest ${manifestPath}:`, error.message);
    return false;
  }
}

async function ensureMonitoringStack() {
  const namespace = CONFIG.monitoringNamespace;
  console.log(`\n========================================`);
  console.log(`Checking monitoring stack in namespace '${namespace}'...`);
  console.log(`========================================\n`);

  // Ensure namespace exists
  await ensureNamespace(namespace);

  const manifestsDir = path.join(__dirname, "..", "..", "manifests");

  // Check if manifests directory exists
  if (!fs.existsSync(manifestsDir)) {
    console.log("Manifests directory not found. Skipping auto-install.");
    return;
  }

  // Check and install Victoria Metrics (moniple-prefixed)
  // Check both vmsingle and vmagent - if either is missing, apply the manifest
  const vmsingleExists = await checkDeploymentExists(
    "moniple-vmsingle",
    namespace,
  );
  const vmagentExists = await checkDeploymentExists(
    "moniple-vmagent",
    namespace,
  );
  const vmagentRbacExists = await checkClusterRoleExists("moniple-vmagent");
  if (!vmsingleExists || !vmagentExists) {
    console.log("\n--- Installing Moniple Victoria Metrics ---");
    if (!vmsingleExists) console.log("  - moniple-vmsingle not found");
    if (!vmagentExists) console.log("  - moniple-vmagent not found");
    await applyManifest(
      path.join(manifestsDir, "victoria-metrics.yaml"),
      namespace,
    );
  } else if (!vmagentRbacExists) {
    // Deployments exist but RBAC is missing - apply RBAC only
    console.log(
      "Moniple Victoria Metrics deployments exist, but vmagent RBAC missing - applying RBAC...",
    );
    await ensureRbacFromManifest(
      path.join(manifestsDir, "victoria-metrics.yaml"),
      namespace,
    );
  } else {
    console.log(
      "Moniple Victoria Metrics already installed (vmsingle + vmagent)",
    );
  }

  // Check and install kube-state-metrics (moniple-prefixed)
  const ksmExists = await checkDeploymentExists(
    "moniple-kube-state-metrics",
    namespace,
  );
  const ksmRbacExists = await checkClusterRoleExists(
    "moniple-kube-state-metrics",
  );
  if (!ksmExists) {
    console.log("\n--- Installing Moniple kube-state-metrics ---");
    await applyManifest(
      path.join(manifestsDir, "kube-state-metrics.yaml"),
      namespace,
    );
  } else if (!ksmRbacExists) {
    // Deployment exists but RBAC is missing - apply RBAC only
    console.log(
      "Moniple kube-state-metrics deployment exists, but RBAC missing - applying RBAC...",
    );
    await ensureRbacFromManifest(
      path.join(manifestsDir, "kube-state-metrics.yaml"),
      namespace,
    );
  } else {
    console.log("Moniple kube-state-metrics already installed");
  }

  // Check and install node-exporter (moniple-prefixed, uses port 9101 to avoid conflicts)
  const neExists = await checkDaemonSetExists(
    "moniple-node-exporter",
    namespace,
  );
  if (!neExists) {
    console.log("\n--- Installing Moniple node-exporter (port 9101) ---");
    await applyManifest(
      path.join(manifestsDir, "node-exporter.yaml"),
      namespace,
    );
  } else {
    console.log("Moniple node-exporter already installed");
  }

  // Update Prometheus API URL to point to local moniple-vmsingle if not set
  if (CONFIG.apiUrl === "http://prometheus:9090/api/v1") {
    CONFIG.apiUrl = `http://moniple-vmsingle.${namespace}.svc:8428/api/v1`;
    console.log(`\nUpdated PROMETHEUS_API_URL to: ${CONFIG.apiUrl}`);
  }

  console.log(`\n========================================`);
  console.log(`Monitoring stack check complete`);
  console.log(`========================================\n`);
}

module.exports = {
  ensureNamespace,
  checkDeploymentExists,
  checkDaemonSetExists,
  checkClusterRoleExists,
  ensureRbacFromManifest,
  applyManifest,
  ensureMonitoringStack,
};
