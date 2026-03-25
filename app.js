const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const k8s = require("@kubernetes/client-node");
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// CORS
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["*"],
  }),
);

// ============================================================================
// SWAGGER DOCUMENTATION
// ============================================================================

const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "Moniple Agent API",
    version: "1.0.0",
    description:
      "Kubernetes cluster metriklerini mobil uygulamalar için optimize edilmiş JSON formatında sunan REST API.",
    contact: { name: "Moniple", url: "https://moniple.com" },
  },
  servers: [{ url: "/", description: "Current server" }],
  tags: [
    { name: "Health", description: "Health check endpoint" },
    { name: "Metrics", description: "Kubernetes cluster metrics" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health Check",
        description: "Servisin çalışıp çalışmadığını kontrol eder",
        responses: {
          200: {
            description: "Servis çalışıyor",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/metrics/overview": {
      get: {
        tags: ["Metrics"],
        summary: "Cluster Overview",
        description:
          "Mobil dashboard için tüm özet bilgileri tek endpoint'te sunar",
        responses: {
          200: {
            description: "Cluster özeti",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OverviewResponse" },
              },
            },
          },
        },
      },
    },
    "/metrics/ns": {
      get: {
        tags: ["Metrics"],
        summary: "Namespace List",
        description: "Cluster'daki tüm namespace'leri listeler",
        responses: {
          200: {
            description: "Namespace listesi",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NamespaceResponse" },
              },
            },
          },
        },
      },
    },
    "/metrics/node": {
      get: {
        tags: ["Metrics"],
        summary: "Node Details",
        description: "Tüm node'ların detaylı kaynak kullanımını gösterir",
        responses: {
          200: {
            description: "Node listesi ve özeti",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NodeResponse" },
              },
            },
          },
        },
      },
    },
    "/metrics/pod": {
      get: {
        tags: ["Metrics"],
        summary: "Pod List",
        description: "Tüm pod'ların durumu ve kaynak kullanımını gösterir",
        responses: {
          200: {
            description: "Pod listesi ve özeti",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PodResponse" },
              },
            },
          },
        },
      },
    },
    "/metrics/pvc": {
      get: {
        tags: ["Metrics"],
        summary: "PVC List",
        description:
          "PersistentVolumeClaim'lerin kapasitesi ve kullanımını gösterir",
        responses: {
          200: {
            description: "PVC listesi",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PvcResponse" },
              },
            },
          },
        },
      },
    },
    "/metrics/alerts": {
      get: {
        tags: ["Metrics"],
        summary: "Alerts",
        description: "Aktif alert'leri listeler",
        responses: {
          200: {
            description: "Alert listesi",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AlertResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      HealthResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          timestamp: { type: "integer", example: 1769062375 },
        },
      },
      OverviewResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          timestamp: { type: "integer", example: 1769062375 },
          cluster: {
            type: "object",
            properties: {
              nodes: { type: "integer", example: 3 },
              pods: {
                type: "object",
                properties: {
                  running: { type: "integer", example: 45 },
                  total: { type: "integer", example: 50 },
                },
              },
            },
          },
          usage: {
            type: "object",
            properties: {
              cpu: { $ref: "#/components/schemas/UsageMetric" },
              memory: { $ref: "#/components/schemas/UsageMetric" },
              disk: { $ref: "#/components/schemas/UsageMetric" },
              pod: { $ref: "#/components/schemas/UsageMetric" },
            },
          },
          alerts: {
            type: "object",
            properties: {
              total: { type: "integer", example: 2 },
              firing: { type: "integer", example: 1 },
              critical: { type: "integer", example: 0 },
            },
          },
          healthy: { type: "boolean", example: true },
        },
      },
      UsageMetric: {
        type: "object",
        properties: {
          value: { type: "number", example: 45 },
          unit: { type: "string", example: "%" },
          critical: { type: "boolean", example: false },
        },
      },
      NamespaceResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          timestamp: { type: "integer", example: 1769062100 },
          count: { type: "integer", example: 26 },
          namespaces: {
            type: "array",
            items: { type: "string" },
            example: ["default", "kube-system", "monitoring"],
          },
        },
      },
      NodeResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          timestamp: { type: "integer", example: 1769062207 },
          summary: { $ref: "#/components/schemas/NodeSummary" },
          nodes: {
            type: "array",
            items: { $ref: "#/components/schemas/Node" },
          },
        },
      },
      NodeSummary: {
        type: "object",
        properties: {
          nodeCount: { type: "integer", example: 3 },
          cpu: { $ref: "#/components/schemas/SummaryMetric" },
          memory: { $ref: "#/components/schemas/SummaryMetric" },
          disk: { $ref: "#/components/schemas/SummaryMetric" },
          pod: { $ref: "#/components/schemas/SummaryMetric" },
        },
      },
      SummaryMetric: {
        type: "object",
        properties: {
          usage: { type: "number", example: 45 },
          total: { type: "number", example: 24 },
          unit: { type: "string", example: "%" },
          critical: { type: "boolean", example: false },
        },
      },
      Node: {
        type: "object",
        properties: {
          name: { type: "string", example: "node-1" },
          instance: { type: "string", example: "192.168.1.10:9100" },
          cpu: { $ref: "#/components/schemas/NodeMetric" },
          memory: { $ref: "#/components/schemas/NodeMetric" },
          disk: { $ref: "#/components/schemas/NodeMetric" },
          pod: { $ref: "#/components/schemas/NodeMetric" },
        },
      },
      NodeMetric: {
        type: "object",
        properties: {
          usage: { type: "number", example: 42 },
          total: { type: "number", example: 8 },
          unit: {
            type: "object",
            properties: {
              usage: { type: "string", example: "%" },
              total: { type: "string", example: "cores" },
            },
          },
          critical: { type: "boolean", example: false },
        },
      },
      PodResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          timestamp: { type: "integer", example: 1769062350 },
          summary: {
            type: "object",
            properties: {
              total: { type: "integer", example: 50 },
              running: { type: "integer", example: 45 },
              pending: { type: "integer", example: 3 },
              failed: { type: "integer", example: 2 },
            },
          },
          pods: { type: "array", items: { $ref: "#/components/schemas/Pod" } },
        },
      },
      Pod: {
        type: "object",
        properties: {
          namespace: { type: "string", example: "production" },
          name: { type: "string", example: "api-server-7d96c4d48f-t8rqn" },
          phase: {
            type: "string",
            enum: ["Running", "Pending", "Failed", "Succeeded", "Unknown"],
            example: "Running",
          },
          cpu: {
            type: "object",
            properties: {
              value: { type: "number", example: 0.125 },
              unit: { type: "string", example: "cores" },
            },
          },
          memory: {
            type: "object",
            properties: {
              value: { type: "number", example: 256.5 },
              unit: { type: "string", example: "MiB" },
            },
          },
        },
      },
      PvcResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          timestamp: { type: "integer", example: 1769062218 },
          count: { type: "integer", example: 5 },
          pvcs: { type: "array", items: { $ref: "#/components/schemas/Pvc" } },
        },
      },
      Pvc: {
        type: "object",
        properties: {
          namespace: { type: "string", example: "monitoring" },
          name: { type: "string", example: "prometheus-data" },
          total: {
            type: "object",
            properties: {
              value: { type: "number", example: 100 },
              unit: { type: "string", example: "GiB" },
            },
          },
          usage: {
            type: "object",
            properties: {
              value: { type: "number", example: 45 },
              unit: { type: "string", example: "%" },
            },
          },
          critical: { type: "boolean", example: false },
        },
      },
      AlertResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          timestamp: { type: "integer", example: 1769062400 },
          summary: {
            type: "object",
            properties: {
              total: { type: "integer", example: 5 },
              firing: { type: "integer", example: 2 },
              pending: { type: "integer", example: 3 },
              critical: { type: "integer", example: 1 },
              warning: { type: "integer", example: 4 },
            },
          },
          alerts: {
            type: "array",
            items: { $ref: "#/components/schemas/Alert" },
          },
        },
      },
      Alert: {
        type: "object",
        properties: {
          name: { type: "string", example: "HighMemoryUsage" },
          severity: {
            type: "string",
            enum: ["critical", "warning", "info"],
            example: "critical",
          },
          state: {
            type: "string",
            enum: ["firing", "pending"],
            example: "firing",
          },
          namespace: { type: "string", example: "production" },
          summary: {
            type: "string",
            example: "Memory usage is above 90% on node-2",
          },
          activeAt: {
            type: "string",
            format: "date-time",
            example: "2026-01-22T08:30:00Z",
          },
        },
      },
      ErrorResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: false },
          error: { type: "string", example: "Error message here" },
        },
      },
    },
  },
};

// Swagger UI
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocument, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "Moniple Agent API",
  }),
);

// Swagger JSON endpoint
app.get("/swagger.json", (req, res) => {
  res.json(swaggerDocument);
});

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  apiUrl: process.env.PROMETHEUS_API_URL || "http://prometheus:9090/api/v1",
  apiUser: process.env.PROMETHEUS_API_USER || "",
  apiPassword: process.env.PROMETHEUS_API_PASSWORD || "",
  threshold: parseInt(process.env.DEFAULT_THRESHOLD) || 80,
  // Moniple Server config
  serverUrl: process.env.MONIPLE_SERVER_URL || "",
  apiKey: process.env.MONIPLE_API_KEY || "",
  pushInterval: parseInt(process.env.PUSH_INTERVAL_SECONDS) || 60,
  // Auto-install monitoring stack
  autoInstallMonitoring: process.env.AUTO_INSTALL_MONITORING !== "false",
  monitoringNamespace: process.env.MONITORING_NAMESPACE || "moniple",
};

// ============================================================================
// KUBERNETES CLIENT & AUTO-INSTALL MONITORING STACK
// ============================================================================

let kc = null;
let k8sAppsApi = null;
let k8sCoreApi = null;
let k8sRbacApi = null;

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
    return true;
  } catch (error) {
    console.error("Failed to initialize Kubernetes client:", error.message);
    return false;
  }
}

async function ensureNamespace(namespace) {
  try {
    await k8sCoreApi.readNamespace(namespace);
    console.log(`Namespace '${namespace}' already exists`);
    return true;
  } catch (error) {
    if (error.statusCode === 404 || error.response?.statusCode === 404) {
      try {
        await k8sCoreApi.createNamespace({
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
    await k8sAppsApi.readNamespacedDeployment(name, namespace);
    return true;
  } catch (error) {
    return false;
  }
}

async function checkDaemonSetExists(name, namespace) {
  try {
    await k8sAppsApi.readNamespacedDaemonSet(name, namespace);
    return true;
  } catch (error) {
    return false;
  }
}

async function checkClusterRoleExists(name) {
  try {
    await k8sRbacApi.readClusterRole(name);
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
            await k8sCoreApi.readNamespacedServiceAccount(name, namespace);
          } catch (e) {
            if (e.statusCode === 404 || e.response?.statusCode === 404) {
              await k8sCoreApi.createNamespacedServiceAccount(
                namespace,
                manifest,
              );
              console.log(`Created ServiceAccount '${name}'`);
            }
          }
          break;

        case "ClusterRole":
          try {
            await k8sRbacApi.readClusterRole(name);
            await k8sRbacApi.replaceClusterRole(name, manifest);
            console.log(`Updated ClusterRole '${name}'`);
          } catch (e) {
            try {
              await k8sRbacApi.createClusterRole(manifest);
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
            await k8sRbacApi.readClusterRoleBinding(name);
            await k8sRbacApi.replaceClusterRoleBinding(name, manifest);
            console.log(`Updated ClusterRoleBinding '${name}'`);
          } catch (e) {
            try {
              await k8sRbacApi.createClusterRoleBinding(manifest);
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
              await k8sCoreApi.readNamespacedServiceAccount(name, namespace);
              console.log(`ServiceAccount '${name}' already exists`);
            } catch (e) {
              await k8sCoreApi.createNamespacedServiceAccount(
                namespace,
                manifest,
              );
              console.log(`Created ServiceAccount '${name}'`);
            }
            break;

          case "ConfigMap":
            try {
              await k8sCoreApi.readNamespacedConfigMap(name, namespace);
              await k8sCoreApi.replaceNamespacedConfigMap(
                name,
                namespace,
                manifest,
              );
              console.log(`Updated ConfigMap '${name}'`);
            } catch (e) {
              await k8sCoreApi.createNamespacedConfigMap(namespace, manifest);
              console.log(`Created ConfigMap '${name}'`);
            }
            break;

          case "Secret":
            try {
              await k8sCoreApi.readNamespacedSecret(name, namespace);
              console.log(`Secret '${name}' already exists`);
            } catch (e) {
              await k8sCoreApi.createNamespacedSecret(namespace, manifest);
              console.log(`Created Secret '${name}'`);
            }
            break;

          case "Service":
            try {
              await k8sCoreApi.readNamespacedService(name, namespace);
              console.log(`Service '${name}' already exists`);
            } catch (e) {
              await k8sCoreApi.createNamespacedService(namespace, manifest);
              console.log(`Created Service '${name}'`);
            }
            break;

          case "Deployment":
            try {
              await k8sAppsApi.readNamespacedDeployment(name, namespace);
              console.log(`Deployment '${name}' already exists`);
            } catch (e) {
              await k8sAppsApi.createNamespacedDeployment(namespace, manifest);
              console.log(`Created Deployment '${name}'`);
            }
            break;

          case "DaemonSet":
            try {
              await k8sAppsApi.readNamespacedDaemonSet(name, namespace);
              console.log(`DaemonSet '${name}' already exists`);
            } catch (e) {
              await k8sAppsApi.createNamespacedDaemonSet(namespace, manifest);
              console.log(`Created DaemonSet '${name}'`);
            }
            break;

          case "ClusterRole":
            try {
              await k8sRbacApi.readClusterRole(name);
              await k8sRbacApi.replaceClusterRole(name, manifest);
              console.log(`Updated ClusterRole '${name}'`);
            } catch (e) {
              try {
                await k8sRbacApi.createClusterRole(manifest);
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
              await k8sRbacApi.readClusterRoleBinding(name);
              await k8sRbacApi.replaceClusterRoleBinding(name, manifest);
              console.log(`Updated ClusterRoleBinding '${name}'`);
            } catch (e) {
              try {
                await k8sRbacApi.createClusterRoleBinding(manifest);
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

  const manifestsDir = path.join(__dirname, "manifests");

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

// ============================================================================
// EMBEDDED PROMQL QUERIES (Compatible with both Prometheus & Victoria Metrics)
// ============================================================================

const QUERIES = {
  // Namespace (kube-state-metrics v2 uses exported_namespace label)
  NS: 'kube_namespace_status_phase{phase="Active"}',

  // PVC - try kubelet stats first, fallback to kube-state-metrics
  PVC_USAGE:
    "sum by (namespace,persistentvolumeclaim) (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes * 100)",
  PVC_TOTAL:
    "sum by (namespace,persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes)",
  // Fallback PVC queries using kube-state-metrics
  PVC_INFO: "kube_persistentvolumeclaim_info",
  PVC_CAPACITY:
    "sum by (namespace,persistentvolumeclaim) (kube_persistentvolumeclaim_resource_requests_storage_bytes)",

  // Pod
  POD_STATUS: "sum by(namespace,pod,phase) (kube_pod_status_phase > 0)",
  POD_CPU_USAGE:
    'sum by (pod,namespace) (rate(container_cpu_usage_seconds_total{pod!=""}[5m]))',
  POD_MEMORY_USAGE:
    'sum by (pod,namespace) (container_memory_working_set_bytes{pod!=""})',
  POD_OWNER: "kube_pod_owner",
  RS_OWNER: "kube_replicaset_owner",

  // Node (use node_uname_info for correct instance, fallback to kube_node_info)
  NODE_INFO: "node_uname_info or kube_node_info",
  NODE_INFO_EXPORTER: "node_uname_info",
  NODE_INFO_KSM: "kube_node_info",
  NODE_MEMORY_USAGE:
    "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100",
  NODE_MEMORY_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="memory"})',
  NODE_DISK_USAGE:
    'max by (instance) ((node_filesystem_size_bytes{fstype=~"ext.?|xfs",mountpoint="/"} - node_filesystem_avail_bytes{fstype=~"ext.?|xfs",mountpoint="/"}) / node_filesystem_size_bytes{fstype=~"ext.?|xfs",mountpoint="/"} * 100)',
  NODE_DISK_USAGE_CADVISOR:
    'max by (instance) (container_fs_usage_bytes{id="/",device=~"/dev/.*"} / container_fs_limit_bytes{id="/",device=~"/dev/.*"} * 100)',
  NODE_DISK_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="ephemeral_storage"})',
  NODE_DISK_TOTAL_CADVISOR:
    'max by (instance) (container_fs_limit_bytes{id="/",device=~"/dev/.*"})',
  NODE_CPU_USAGE:
    '(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100',
  NODE_CPU_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="cpu"})',
  NODE_POD_USAGE:
    'count by (node) (kube_pod_info) / sum by (node) (kube_node_status_allocatable{resource="pods"}) * 100',
  NODE_POD_TOTAL:
    'sum by (node) (kube_node_status_allocatable{resource="pods"})',
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB"];

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return { value: 0, unit: "bytes" };
  let value = parseFloat(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return {
    value: Math.round(value * 10) / 10,
    unit: UNITS[unitIndex],
  };
}

function round(num, decimals = 1) {
  if (num === null || num === undefined || isNaN(num)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(parseFloat(num) * factor) / factor;
}

function getTimestamp() {
  return Math.floor(Date.now() / 1000);
}

// ============================================================================
// PROMETHEUS/VICTORIAMETRICS API CLIENT
// ============================================================================

async function queryPrometheus(query) {
  const url = `${CONFIG.apiUrl}/query?query=${encodeURIComponent(query)}`;
  const options = {};

  if (CONFIG.apiUser && CONFIG.apiPassword) {
    const auth = Buffer.from(
      `${CONFIG.apiUser}:${CONFIG.apiPassword}`,
    ).toString("base64");
    options.headers = { Authorization: `Basic ${auth}` };
  }

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    if (data.status === "success") {
      return data.data.result || [];
    }
    console.error("Query failed:", query, data.error);
    return [];
  } catch (error) {
    console.error("Fetch error:", error.message);
    return [];
  }
}

async function fetchAlerts() {
  const url = `${CONFIG.apiUrl}/alerts`;
  const options = {};

  if (CONFIG.apiUser && CONFIG.apiPassword) {
    const auth = Buffer.from(
      `${CONFIG.apiUser}:${CONFIG.apiPassword}`,
    ).toString("base64");
    options.headers = { Authorization: `Basic ${auth}` };
  }

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data.status === "success" ? data.data.alerts || [] : [];
  } catch (error) {
    console.error("Alerts fetch error:", error.message);
    return [];
  }
}

// ============================================================================
// ENDPOINTS
// ============================================================================

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: getTimestamp() });
});

// -----------------------------------------------------------------------------
// GET /metrics/ns - Namespace listesi
// -----------------------------------------------------------------------------
app.get("/metrics/ns", async (req, res) => {
  try {
    const result = await queryPrometheus(QUERIES.NS);
    // kube-state-metrics v2 uses exported_namespace, v1 uses namespace
    const namespaces = result
      .map((item) => item.metric.exported_namespace || item.metric.namespace)
      .filter(Boolean);

    res.json({
      ok: true,
      timestamp: getTimestamp(),
      count: namespaces.length,
      namespaces: [...new Set(namespaces)].sort(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/pod - Pod durumları ve resource kullanımı
// -----------------------------------------------------------------------------
app.get("/metrics/pod", async (req, res) => {
  try {
    const [statusData, cpuData, memoryData, ownerData, rsOwnerData] =
      await Promise.all([
        queryPrometheus(QUERIES.POD_STATUS),
        queryPrometheus(QUERIES.POD_CPU_USAGE),
        queryPrometheus(QUERIES.POD_MEMORY_USAGE),
        queryPrometheus(QUERIES.POD_OWNER),
        queryPrometheus(QUERIES.RS_OWNER),
      ]);

    // Build ReplicaSet → Deployment lookup map
    const rsToDeployment = {};
    for (const rs of rsOwnerData) {
      const ns = rs.metric.namespace;
      const rsName = rs.metric.replicaset;
      const ownerKind = rs.metric.owner_kind;
      const ownerName = rs.metric.owner_name;
      if (ownerKind === "Deployment" && rsName && ownerName) {
        rsToDeployment[`${ns}/${rsName}`] = ownerName;
      }
    }

    const pods = statusData.map((item) => {
      const namespace = item.metric.namespace;
      const podName = item.metric.pod;

      // CPU (cAdvisor uses namespace/pod labels - match by pod name since namespace might differ)
      const cpuItem = cpuData.find(
        (c) => c.metric.pod === podName && c.metric.namespace === namespace,
      );
      const cpuCores = cpuItem ? round(parseFloat(cpuItem.value[1]), 3) : 0;

      // Memory
      const memItem = memoryData.find(
        (m) => m.metric.pod === podName && m.metric.namespace === namespace,
      );
      const memory = memItem
        ? formatBytes(memItem.value[1])
        : { value: 0, unit: "bytes" };

      // Owner resolution: Pod → ReplicaSet → Deployment, or Pod → StatefulSet/DaemonSet/Job
      const ownerItem = ownerData.find(
        (o) => o.metric.pod === podName && o.metric.namespace === namespace,
      );
      let ownerKind = null;
      let ownerName = null;
      if (ownerItem) {
        const directKind = ownerItem.metric.owner_kind;
        const directName = ownerItem.metric.owner_name;

        if (directKind === "ReplicaSet") {
          // Resolve ReplicaSet → Deployment via kube_replicaset_owner
          const deploymentName =
            rsToDeployment[`${namespace}/${directName}`];
          if (deploymentName) {
            ownerKind = "Deployment";
            ownerName = deploymentName;
          } else {
            // Standalone ReplicaSet (not owned by a Deployment)
            ownerKind = "ReplicaSet";
            ownerName = directName;
          }
        } else if (
          directKind &&
          directKind !== "<none>" &&
          directKind !== "Node"
        ) {
          // StatefulSet, DaemonSet, Job, CronJob, etc.
          ownerKind = directKind;
          ownerName = directName;
        }
      }

      return {
        namespace,
        name: podName,
        phase: item.metric.phase,
        ownerKind,
        ownerName,
        cpu: { value: cpuCores, unit: "cores" },
        memory: { value: memory.value, unit: memory.unit },
      };
    });

    // Summary
    const summary = {
      total: pods.length,
      running: pods.filter((p) => p.phase === "Running").length,
      pending: pods.filter((p) => p.phase === "Pending").length,
      failed: pods.filter((p) => p.phase === "Failed").length,
    };

    res.json({
      ok: true,
      timestamp: getTimestamp(),
      summary,
      pods,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/pvc - PersistentVolumeClaim durumları
// -----------------------------------------------------------------------------
app.get("/metrics/pvc", async (req, res) => {
  try {
    // Try kubelet_volume_stats first (provides actual usage)
    let [totalData, usageData] = await Promise.all([
      queryPrometheus(QUERIES.PVC_TOTAL),
      queryPrometheus(QUERIES.PVC_USAGE),
    ]);

    // Fallback to kube-state-metrics if kubelet_volume_stats not available
    if (totalData.length === 0) {
      totalData = await queryPrometheus(QUERIES.PVC_CAPACITY);
    }

    const pvcs = totalData.map((item) => {
      // Handle both kubelet and kube-state-metrics label formats
      const namespace = item.metric.exported_namespace || item.metric.namespace;
      const pvcName =
        item.metric.exported_persistentvolumeclaim ||
        item.metric.persistentvolumeclaim;

      const total = formatBytes(item.value[1]);
      const usageItem = usageData.find(
        (u) =>
          (u.metric.exported_namespace || u.metric.namespace) === namespace &&
          (u.metric.exported_persistentvolumeclaim ||
            u.metric.persistentvolumeclaim) === pvcName,
      );
      // If no usage data available, show N/A
      const usagePercent = usageItem
        ? round(parseFloat(usageItem.value[1]))
        : null;

      return {
        namespace,
        name: pvcName,
        total: { value: total.value, unit: total.unit },
        usage:
          usagePercent !== null
            ? { value: usagePercent, unit: "%" }
            : { value: "N/A", unit: "" },
        critical:
          usagePercent !== null ? usagePercent > CONFIG.threshold : false,
      };
    });

    res.json({
      ok: true,
      timestamp: getTimestamp(),
      count: pvcs.length,
      pvcs,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/node - Node durumları ve resource kullanımı
// -----------------------------------------------------------------------------
app.get("/metrics/node", async (req, res) => {
  try {
    // Try node_uname_info first (has correct instance for node-exporter), fallback to kube_node_info
    let [
      nodeInfoExporter,
      nodeInfoKsm,
      memUsage,
      memTotal,
      diskUsage,
      diskUsageCadvisor,
      diskTotal,
      diskTotalCadvisor,
      cpuUsage,
      cpuTotal,
      podUsage,
      podTotal,
    ] = await Promise.all([
      queryPrometheus(QUERIES.NODE_INFO_EXPORTER),
      queryPrometheus(QUERIES.NODE_INFO_KSM),
      queryPrometheus(QUERIES.NODE_MEMORY_USAGE),
      queryPrometheus(QUERIES.NODE_MEMORY_TOTAL),
      queryPrometheus(QUERIES.NODE_DISK_USAGE),
      queryPrometheus(QUERIES.NODE_DISK_USAGE_CADVISOR),
      queryPrometheus(QUERIES.NODE_DISK_TOTAL),
      queryPrometheus(QUERIES.NODE_DISK_TOTAL_CADVISOR),
      queryPrometheus(QUERIES.NODE_CPU_USAGE),
      queryPrometheus(QUERIES.NODE_CPU_TOTAL),
      queryPrometheus(QUERIES.NODE_POD_USAGE),
      queryPrometheus(QUERIES.NODE_POD_TOTAL),
    ]);

    // Use node_filesystem metrics if available, otherwise fallback to cadvisor
    // Important: both usage and total must come from the same source for consistency
    const useCadvisorDisk = diskUsage.length === 0;
    const effectiveDiskUsage = useCadvisorDisk ? diskUsageCadvisor : diskUsage;
    const effectiveDiskTotal = useCadvisorDisk ? diskTotalCadvisor : diskTotal;

    // Prefer node_uname_info (node-exporter), fallback to kube_node_info
    const nodeInfo =
      nodeInfoExporter.length > 0 ? nodeInfoExporter : nodeInfoKsm;

    const nodes = nodeInfo.map((item) => {
      // node_uname_info uses nodename, kube_node_info uses node label
      const nodeName =
        item.metric.nodename || item.metric.node || item.metric.exported_node;
      // node_uname_info has correct instance for node-exporter metrics
      const instance = item.metric.instance;

      // Memory (node-exporter uses instance label)
      const memUsageItem = memUsage.find((m) => m.metric.instance === instance);
      const memTotalItem = memTotal.find((m) => m.metric.node === nodeName);
      const memoryUsagePercent = memUsageItem
        ? round(parseFloat(memUsageItem.value[1]))
        : 0;
      const memoryTotal = memTotalItem
        ? formatBytes(memTotalItem.value[1])
        : { value: 0, unit: "GiB" };

      // Disk (try node_filesystem first, fallback to cadvisor)
      // node_filesystem uses instance like "192.168.65.3:9100"
      // cadvisor uses instance as hostname like "docker-desktop" or kubernetes_io_hostname
      const diskUsageItem = effectiveDiskUsage.find(
        (d) =>
          d.metric.instance === instance ||
          d.metric.instance === nodeName ||
          d.metric.kubernetes_io_hostname === nodeName,
      );
      const diskTotalItem = effectiveDiskTotal.find(
        (d) =>
          d.metric.node === nodeName ||
          d.metric.instance === instance ||
          d.metric.instance === nodeName ||
          d.metric.kubernetes_io_hostname === nodeName,
      );
      const diskUsagePercent = diskUsageItem
        ? round(parseFloat(diskUsageItem.value[1]))
        : 0;
      const diskTotalVal = diskTotalItem
        ? formatBytes(diskTotalItem.value[1])
        : { value: 0, unit: "GiB" };

      // CPU
      const cpuUsageItem = cpuUsage.find((c) => c.metric.instance === instance);
      const cpuTotalItem = cpuTotal.find((c) => c.metric.node === nodeName);
      const cpuUsagePercent = cpuUsageItem
        ? round(parseFloat(cpuUsageItem.value[1]))
        : 0;
      const cpuTotalVal = cpuTotalItem
        ? round(parseFloat(cpuTotalItem.value[1]))
        : 0;

      // Pod
      const podUsageItem = podUsage.find((p) => p.metric.node === nodeName);
      const podTotalItem = podTotal.find((p) => p.metric.node === nodeName);
      const podUsagePercent = podUsageItem
        ? round(parseFloat(podUsageItem.value[1]))
        : 0;
      const podTotalVal = podTotalItem
        ? round(parseFloat(podTotalItem.value[1]))
        : 0;

      return {
        name: nodeName,
        instance,
        cpu: {
          usage: cpuUsagePercent,
          total: cpuTotalVal,
          unit: { usage: "%", total: "cores" },
          critical: cpuUsagePercent > CONFIG.threshold,
        },
        memory: {
          usage: memoryUsagePercent,
          total: memoryTotal.value,
          unit: { usage: "%", total: memoryTotal.unit },
          critical: memoryUsagePercent > CONFIG.threshold,
        },
        disk: {
          usage: diskUsagePercent,
          total: diskTotalVal.value,
          unit: { usage: "%", total: diskTotalVal.unit },
          critical: diskUsagePercent > CONFIG.threshold,
        },
        pod: {
          usage: podUsagePercent,
          total: podTotalVal,
          unit: { usage: "%", total: "pods" },
          critical: podUsagePercent > CONFIG.threshold,
        },
      };
    });

    // Cluster summary
    const nodeCount = nodes.length || 1;
    const summary = {
      nodeCount,
      cpu: {
        usage: round(
          nodes.reduce((sum, n) => sum + n.cpu.usage, 0) / nodeCount,
        ),
        total: nodes.reduce((sum, n) => sum + n.cpu.total, 0),
        unit: "%",
        critical: nodes.some((n) => n.cpu.critical),
      },
      memory: {
        usage: round(
          nodes.reduce((sum, n) => sum + n.memory.usage, 0) / nodeCount,
        ),
        total: round(nodes.reduce((sum, n) => sum + n.memory.total, 0)),
        unit: "%",
        critical: nodes.some((n) => n.memory.critical),
      },
      disk: {
        usage: round(
          nodes.reduce((sum, n) => sum + n.disk.usage, 0) / nodeCount,
        ),
        total: round(nodes.reduce((sum, n) => sum + n.disk.total, 0)),
        unit: "%",
        critical: nodes.some((n) => n.disk.critical),
      },
      pod: {
        usage: round(
          nodes.reduce((sum, n) => sum + n.pod.usage, 0) / nodeCount,
        ),
        total: nodes.reduce((sum, n) => sum + n.pod.total, 0),
        unit: "%",
        critical: nodes.some((n) => n.pod.critical),
      },
    };

    res.json({
      ok: true,
      timestamp: getTimestamp(),
      summary,
      nodes,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/alerts - Aktif alertler
// -----------------------------------------------------------------------------
app.get("/metrics/alerts", async (req, res) => {
  try {
    const alerts = await fetchAlerts();

    const formatted = alerts.map((alert) => ({
      name: alert.labels?.alertname || "Unknown",
      severity: alert.labels?.severity || "unknown",
      state: alert.state,
      namespace: alert.labels?.namespace || "",
      summary:
        alert.annotations?.summary || alert.annotations?.description || "",
      activeAt: alert.activeAt,
    }));

    const summary = {
      total: formatted.length,
      firing: formatted.filter((a) => a.state === "firing").length,
      pending: formatted.filter((a) => a.state === "pending").length,
      critical: formatted.filter((a) => a.severity === "critical").length,
      warning: formatted.filter((a) => a.severity === "warning").length,
    };

    res.json({
      ok: true,
      timestamp: getTimestamp(),
      summary,
      alerts: formatted,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// GET /metrics/overview - Mobil dashboard için tek endpoint
// -----------------------------------------------------------------------------
app.get("/metrics/overview", async (req, res) => {
  try {
    const [
      nodeInfo,
      memUsage,
      cpuUsage,
      diskUsage,
      diskUsageCadvisor,
      podUsage,
      podStatus,
      alerts,
    ] = await Promise.all([
      queryPrometheus(QUERIES.NODE_INFO),
      queryPrometheus(QUERIES.NODE_MEMORY_USAGE),
      queryPrometheus(QUERIES.NODE_CPU_USAGE),
      queryPrometheus(QUERIES.NODE_DISK_USAGE),
      queryPrometheus(QUERIES.NODE_DISK_USAGE_CADVISOR),
      queryPrometheus(QUERIES.NODE_POD_USAGE),
      queryPrometheus(QUERIES.POD_STATUS),
      fetchAlerts(),
    ]);

    // Use node_filesystem metrics if available, otherwise fallback to cadvisor
    const effectiveDiskUsage =
      diskUsage.length > 0 ? diskUsage : diskUsageCadvisor;

    const nodeCount = nodeInfo.length || 1;

    // Calculate averages (handle empty arrays)
    const avgCpu =
      cpuUsage.length > 0
        ? round(
            cpuUsage.reduce((sum, c) => sum + parseFloat(c.value[1] || 0), 0) /
              cpuUsage.length,
          )
        : 0;
    const avgMemory =
      memUsage.length > 0
        ? round(
            memUsage.reduce((sum, m) => sum + parseFloat(m.value[1] || 0), 0) /
              memUsage.length,
          )
        : 0;
    const avgDisk =
      effectiveDiskUsage.length > 0
        ? round(
            effectiveDiskUsage.reduce(
              (sum, d) => sum + parseFloat(d.value[1] || 0),
              0,
            ) / effectiveDiskUsage.length,
          )
        : 0;
    const avgPod =
      podUsage.length > 0
        ? round(
            podUsage.reduce((sum, p) => sum + parseFloat(p.value[1] || 0), 0) /
              podUsage.length,
          )
        : 0;

    // Pod summary
    const runningPods = podStatus.filter(
      (p) => p.metric.phase === "Running",
    ).length;
    const totalPods = podStatus.length;

    // Alert summary
    const firingAlerts = alerts.filter((a) => a.state === "firing").length;
    const criticalAlerts = alerts.filter(
      (a) => a.labels?.severity === "critical",
    ).length;

    res.json({
      ok: true,
      timestamp: getTimestamp(),
      cluster: {
        nodes: nodeCount,
        pods: { running: runningPods, total: totalPods },
      },
      usage: {
        cpu: { value: avgCpu, unit: "%", critical: avgCpu > CONFIG.threshold },
        memory: {
          value: avgMemory,
          unit: "%",
          critical: avgMemory > CONFIG.threshold,
        },
        disk: {
          value: avgDisk,
          unit: "%",
          critical: avgDisk > CONFIG.threshold,
        },
        pod: { value: avgPod, unit: "%", critical: avgPod > CONFIG.threshold },
      },
      alerts: {
        total: alerts.length,
        firing: firingAlerts,
        critical: criticalAlerts,
      },
      healthy:
        avgCpu < CONFIG.threshold &&
        avgMemory < CONFIG.threshold &&
        avgDisk < CONFIG.threshold &&
        criticalAlerts === 0,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================================
// MONIPLE SERVER PUSH FUNCTIONS
// ============================================================================

// Internal functions to get metrics data (reuse endpoint logic)
async function getOverviewData() {
  const [
    nodeInfo,
    memUsage,
    cpuUsage,
    diskUsage,
    diskUsageCadvisor,
    podUsage,
    podStatus,
    alerts,
  ] = await Promise.all([
    queryPrometheus(QUERIES.NODE_INFO),
    queryPrometheus(QUERIES.NODE_MEMORY_USAGE),
    queryPrometheus(QUERIES.NODE_CPU_USAGE),
    queryPrometheus(QUERIES.NODE_DISK_USAGE),
    queryPrometheus(QUERIES.NODE_DISK_USAGE_CADVISOR),
    queryPrometheus(QUERIES.NODE_POD_USAGE),
    queryPrometheus(QUERIES.POD_STATUS),
    fetchAlerts(),
  ]);

  // Use node_filesystem metrics if available, otherwise fallback to cadvisor
  const effectiveDiskUsage =
    diskUsage.length > 0 ? diskUsage : diskUsageCadvisor;

  const nodeCount = nodeInfo.length || 1;
  const avgCpu =
    cpuUsage.length > 0
      ? round(
          cpuUsage.reduce((sum, c) => sum + parseFloat(c.value[1] || 0), 0) /
            cpuUsage.length,
        )
      : 0;
  const avgMemory =
    memUsage.length > 0
      ? round(
          memUsage.reduce((sum, m) => sum + parseFloat(m.value[1] || 0), 0) /
            memUsage.length,
        )
      : 0;
  const avgDisk =
    effectiveDiskUsage.length > 0
      ? round(
          effectiveDiskUsage.reduce(
            (sum, d) => sum + parseFloat(d.value[1] || 0),
            0,
          ) / effectiveDiskUsage.length,
        )
      : 0;
  const avgPod =
    podUsage.length > 0
      ? round(
          podUsage.reduce((sum, p) => sum + parseFloat(p.value[1] || 0), 0) /
            podUsage.length,
        )
      : 0;

  const runningPods = podStatus.filter(
    (p) => p.metric.phase === "Running",
  ).length;
  const totalPods = podStatus.length;
  const firingAlerts = alerts.filter((a) => a.state === "firing").length;
  const criticalAlerts = alerts.filter(
    (a) => a.labels?.severity === "critical",
  ).length;

  return {
    ok: true,
    timestamp: getTimestamp(),
    cluster: {
      nodes: nodeCount,
      pods: { running: runningPods, total: totalPods },
    },
    usage: {
      cpu: { value: avgCpu, unit: "%", critical: avgCpu > CONFIG.threshold },
      memory: {
        value: avgMemory,
        unit: "%",
        critical: avgMemory > CONFIG.threshold,
      },
      disk: { value: avgDisk, unit: "%", critical: avgDisk > CONFIG.threshold },
      pod: { value: avgPod, unit: "%", critical: avgPod > CONFIG.threshold },
    },
    alerts: {
      total: alerts.length,
      firing: firingAlerts,
      critical: criticalAlerts,
    },
    healthy:
      avgCpu < CONFIG.threshold &&
      avgMemory < CONFIG.threshold &&
      avgDisk < CONFIG.threshold &&
      criticalAlerts === 0,
  };
}

async function getNodeData() {
  let [
    nodeInfoExporter,
    nodeInfoKsm,
    memUsage,
    memTotal,
    diskUsage,
    diskTotal,
    cpuUsage,
    cpuTotal,
    podUsage,
    podTotal,
  ] = await Promise.all([
    queryPrometheus(QUERIES.NODE_INFO_EXPORTER),
    queryPrometheus(QUERIES.NODE_INFO_KSM),
    queryPrometheus(QUERIES.NODE_MEMORY_USAGE),
    queryPrometheus(QUERIES.NODE_MEMORY_TOTAL),
    queryPrometheus(QUERIES.NODE_DISK_USAGE),
    queryPrometheus(QUERIES.NODE_DISK_TOTAL),
    queryPrometheus(QUERIES.NODE_CPU_USAGE),
    queryPrometheus(QUERIES.NODE_CPU_TOTAL),
    queryPrometheus(QUERIES.NODE_POD_USAGE),
    queryPrometheus(QUERIES.NODE_POD_TOTAL),
  ]);

  const nodeInfo = nodeInfoExporter.length > 0 ? nodeInfoExporter : nodeInfoKsm;

  const nodes = nodeInfo.map((item) => {
    const nodeName =
      item.metric.nodename || item.metric.node || item.metric.exported_node;
    const instance = item.metric.instance;

    const memUsageItem = memUsage.find((m) => m.metric.instance === instance);
    const memTotalItem = memTotal.find((m) => m.metric.node === nodeName);
    const memoryUsagePercent = memUsageItem
      ? round(parseFloat(memUsageItem.value[1]))
      : 0;
    const memoryTotal = memTotalItem
      ? formatBytes(memTotalItem.value[1])
      : { value: 0, unit: "GiB" };

    const diskUsageItem = diskUsage.find((d) => d.metric.instance === instance);
    const diskTotalItem = diskTotal.find((d) => d.metric.node === nodeName);
    const diskUsagePercent = diskUsageItem
      ? round(parseFloat(diskUsageItem.value[1]))
      : 0;
    const diskTotalVal = diskTotalItem
      ? formatBytes(diskTotalItem.value[1])
      : { value: 0, unit: "GiB" };

    const cpuUsageItem = cpuUsage.find((c) => c.metric.instance === instance);
    const cpuTotalItem = cpuTotal.find((c) => c.metric.node === nodeName);
    const cpuUsagePercent = cpuUsageItem
      ? round(parseFloat(cpuUsageItem.value[1]))
      : 0;
    const cpuTotalVal = cpuTotalItem
      ? round(parseFloat(cpuTotalItem.value[1]))
      : 0;

    const podUsageItem = podUsage.find((p) => p.metric.node === nodeName);
    const podTotalItem = podTotal.find((p) => p.metric.node === nodeName);
    const podUsagePercent = podUsageItem
      ? round(parseFloat(podUsageItem.value[1]))
      : 0;
    const podTotalVal = podTotalItem
      ? round(parseFloat(podTotalItem.value[1]))
      : 0;

    return {
      name: nodeName,
      instance,
      cpu: {
        usage: cpuUsagePercent,
        total: cpuTotalVal,
        unit: { usage: "%", total: "cores" },
        critical: cpuUsagePercent > CONFIG.threshold,
      },
      memory: {
        usage: memoryUsagePercent,
        total: memoryTotal.value,
        unit: { usage: "%", total: memoryTotal.unit },
        critical: memoryUsagePercent > CONFIG.threshold,
      },
      disk: {
        usage: diskUsagePercent,
        total: diskTotalVal.value,
        unit: { usage: "%", total: diskTotalVal.unit },
        critical: diskUsagePercent > CONFIG.threshold,
      },
      pod: {
        usage: podUsagePercent,
        total: podTotalVal,
        unit: { usage: "%", total: "pods" },
        critical: podUsagePercent > CONFIG.threshold,
      },
    };
  });

  const nodeCount = nodes.length || 1;
  const summary = {
    nodeCount,
    cpu: {
      usage: round(nodes.reduce((sum, n) => sum + n.cpu.usage, 0) / nodeCount),
      total: nodes.reduce((sum, n) => sum + n.cpu.total, 0),
      unit: "%",
      critical: nodes.some((n) => n.cpu.critical),
    },
    memory: {
      usage: round(
        nodes.reduce((sum, n) => sum + n.memory.usage, 0) / nodeCount,
      ),
      total: round(nodes.reduce((sum, n) => sum + n.memory.total, 0)),
      unit: "%",
      critical: nodes.some((n) => n.memory.critical),
    },
    disk: {
      usage: round(nodes.reduce((sum, n) => sum + n.disk.usage, 0) / nodeCount),
      total: round(nodes.reduce((sum, n) => sum + n.disk.total, 0)),
      unit: "%",
      critical: nodes.some((n) => n.disk.critical),
    },
    pod: {
      usage: round(nodes.reduce((sum, n) => sum + n.pod.usage, 0) / nodeCount),
      total: nodes.reduce((sum, n) => sum + n.pod.total, 0),
      unit: "%",
      critical: nodes.some((n) => n.pod.critical),
    },
  };

  return { ok: true, timestamp: getTimestamp(), summary, nodes };
}

async function getPodData() {
  const [statusData, cpuData, memoryData, ownerData, rsOwnerData] =
    await Promise.all([
      queryPrometheus(QUERIES.POD_STATUS),
      queryPrometheus(QUERIES.POD_CPU_USAGE),
      queryPrometheus(QUERIES.POD_MEMORY_USAGE),
      queryPrometheus(QUERIES.POD_OWNER),
      queryPrometheus(QUERIES.RS_OWNER),
    ]);

  // Build ReplicaSet → Deployment lookup map
  const rsToDeployment = {};
  for (const rs of rsOwnerData) {
    const ns = rs.metric.namespace;
    const rsName = rs.metric.replicaset;
    const ownerKind = rs.metric.owner_kind;
    const ownerName = rs.metric.owner_name;
    if (ownerKind === "Deployment" && rsName && ownerName) {
      rsToDeployment[`${ns}/${rsName}`] = ownerName;
    }
  }

  const pods = statusData.map((item) => {
    const namespace = item.metric.exported_namespace || item.metric.namespace;
    const podName = item.metric.pod;
    const cpuItem = cpuData.find(
      (c) => c.metric.pod === podName && c.metric.namespace === namespace,
    );
    const cpuCores = cpuItem ? round(parseFloat(cpuItem.value[1]), 3) : 0;
    const memItem = memoryData.find(
      (m) => m.metric.pod === podName && m.metric.namespace === namespace,
    );
    const memory = memItem
      ? formatBytes(memItem.value[1])
      : { value: 0, unit: "bytes" };

    // Owner resolution: Pod → ReplicaSet → Deployment, or Pod → StatefulSet/DaemonSet/Job
    const ownerItem = ownerData.find(
      (o) => o.metric.pod === podName && o.metric.namespace === namespace,
    );
    let podOwnerKind = null;
    let podOwnerName = null;
    if (ownerItem) {
      const directKind = ownerItem.metric.owner_kind;
      const directName = ownerItem.metric.owner_name;

      if (directKind === "ReplicaSet") {
        const deploymentName =
          rsToDeployment[`${namespace}/${directName}`];
        if (deploymentName) {
          podOwnerKind = "Deployment";
          podOwnerName = deploymentName;
        } else {
          podOwnerKind = "ReplicaSet";
          podOwnerName = directName;
        }
      } else if (
        directKind &&
        directKind !== "<none>" &&
        directKind !== "Node"
      ) {
        podOwnerKind = directKind;
        podOwnerName = directName;
      }
    }

    return {
      namespace,
      name: podName,
      phase: item.metric.phase,
      ownerKind: podOwnerKind,
      ownerName: podOwnerName,
      cpu: { value: cpuCores, unit: "cores" },
      memory: { value: memory.value, unit: memory.unit },
    };
  });

  const summary = {
    total: pods.length,
    running: pods.filter((p) => p.phase === "Running").length,
    pending: pods.filter((p) => p.phase === "Pending").length,
    failed: pods.filter((p) => p.phase === "Failed").length,
  };

  return { ok: true, timestamp: getTimestamp(), summary, pods };
}

async function getPvcData() {
  let [totalData, usageData] = await Promise.all([
    queryPrometheus(QUERIES.PVC_TOTAL),
    queryPrometheus(QUERIES.PVC_USAGE),
  ]);

  if (totalData.length === 0) {
    totalData = await queryPrometheus(QUERIES.PVC_CAPACITY);
  }

  const pvcs = totalData.map((item) => {
    const namespace = item.metric.exported_namespace || item.metric.namespace;
    const pvcName =
      item.metric.exported_persistentvolumeclaim ||
      item.metric.persistentvolumeclaim;
    const total = formatBytes(item.value[1]);
    const usageItem = usageData.find(
      (u) =>
        (u.metric.exported_namespace || u.metric.namespace) === namespace &&
        (u.metric.exported_persistentvolumeclaim ||
          u.metric.persistentvolumeclaim) === pvcName,
    );
    const usagePercent = usageItem
      ? round(parseFloat(usageItem.value[1]))
      : null;

    return {
      namespace,
      name: pvcName,
      total: { value: total.value, unit: total.unit },
      usage:
        usagePercent !== null
          ? { value: usagePercent, unit: "%" }
          : { value: "N/A", unit: "" },
      critical: usagePercent !== null ? usagePercent > CONFIG.threshold : false,
    };
  });

  return { ok: true, timestamp: getTimestamp(), count: pvcs.length, pvcs };
}

async function getNsData() {
  const result = await queryPrometheus(QUERIES.NS);
  const namespaces = result
    .map((item) => item.metric.exported_namespace || item.metric.namespace)
    .filter(Boolean);

  return {
    ok: true,
    timestamp: getTimestamp(),
    count: namespaces.length,
    namespaces: [...new Set(namespaces)].sort(),
  };
}

async function getAlertsData() {
  const alerts = await fetchAlerts();
  const formatted = alerts.map((alert) => ({
    name: alert.labels?.alertname || "Unknown",
    severity: alert.labels?.severity || "unknown",
    state: alert.state,
    namespace: alert.labels?.namespace || "",
    summary: alert.annotations?.summary || alert.annotations?.description || "",
    activeAt: alert.activeAt,
  }));

  const summary = {
    total: formatted.length,
    firing: formatted.filter((a) => a.state === "firing").length,
    pending: formatted.filter((a) => a.state === "pending").length,
    critical: formatted.filter((a) => a.severity === "critical").length,
    warning: formatted.filter((a) => a.severity === "warning").length,
  };

  return { ok: true, timestamp: getTimestamp(), summary, alerts: formatted };
}

// Push all metrics to Moniple Server
async function pushMetricsToServer() {
  if (!CONFIG.serverUrl || !CONFIG.apiKey) {
    return; // Server not configured, skip push
  }

  try {
    console.log(`[${new Date().toISOString()}] Pushing metrics to server...`);

    // Collect all metrics in parallel
    const [overview, node, pod, pvc, ns, alerts] = await Promise.all([
      getOverviewData().catch((e) => {
        console.error("Overview error:", e.message);
        return null;
      }),
      getNodeData().catch((e) => {
        console.error("Node error:", e.message);
        return null;
      }),
      getPodData().catch((e) => {
        console.error("Pod error:", e.message);
        return null;
      }),
      getPvcData().catch((e) => {
        console.error("PVC error:", e.message);
        return null;
      }),
      getNsData().catch((e) => {
        console.error("NS error:", e.message);
        return null;
      }),
      getAlertsData().catch((e) => {
        console.error("Alerts error:", e.message);
        return null;
      }),
    ]);

    // Push to server using /api/v1/agent/snapshots endpoint
    // Cluster ID is automatically resolved from API key on server side
    const response = await fetch(`${CONFIG.serverUrl}/api/v1/agent/snapshots`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify({
        overview,
        node,
        pod,
        pvc,
        ns,
        alerts,
      }),
    });

    const result = await response.json();
    if (result.ok) {
      console.log(
        `[${new Date().toISOString()}] Metrics pushed successfully:`,
        result.data?.stored?.join(", "),
      );
    } else {
      console.error(`[${new Date().toISOString()}] Push failed:`, result.error);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Push error:`, error.message);
  }
}

// Start push interval
function startMetricsPush() {
  if (!CONFIG.serverUrl || !CONFIG.apiKey) {
    console.log("Moniple Server not configured. Skipping metrics push.");
    return;
  }

  console.log(
    `Starting metrics push to ${CONFIG.serverUrl} every ${CONFIG.pushInterval}s`,
  );

  // Initial push after 5 seconds
  setTimeout(pushMetricsToServer, 5000);

  // Then push at configured interval
  setInterval(pushMetricsToServer, CONFIG.pushInterval * 1000);
}

// ============================================================================
// START SERVER
// ============================================================================

async function startServer() {
  // Initialize Kubernetes client and ensure monitoring stack
  if (CONFIG.autoInstallMonitoring) {
    const k8sInitialized = initKubernetesClient();
    if (k8sInitialized) {
      try {
        await ensureMonitoringStack();
      } catch (error) {
        console.error("Error ensuring monitoring stack:", error.message);
      }
    } else {
      console.log("Kubernetes client not available. Skipping auto-install.");
    }
  } else {
    console.log(
      "Auto-install monitoring disabled (AUTO_INSTALL_MONITORING=false)",
    );
  }

  // Start Express server
  app.listen(port, () => {
    console.log(`Moniple Agent running on port ${port}`);
    console.log(`Prometheus API: ${CONFIG.apiUrl}`);

    // Start pushing metrics to server
    startMetricsPush();
  });
}

// Start the server
startServer();
