// ============================================================================
// SWAGGER / OpenAPI SPEC
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

module.exports = swaggerDocument;
