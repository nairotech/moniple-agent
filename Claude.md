# Moniple Agent - Session Notları

## Proje Amacı
Kubernetes cluster metriklerini Prometheus/Victoria Metrics'ten çekip mobil uygulama için sadeleştirilmiş JSON endpoint'leri sunan bir Express.js uygulaması.

---

## Yapılan İşlemler (22 Ocak 2026)

### 1. Kod Refactoring

**Önceki Sorunlar:**
- 19 adet environment variable vardı (PQL_* sorguları)
- PromQL sorguları sadece kube-prometheus-stack için yazılmıştı
- `service="kube-prometheus-stack-kubelet"` gibi hardcoded label'lar vardı
- Recording rule bağımlılığı vardı (`node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate`)
- Basic auth'da template literal hatası vardı

**Yapılan Düzeltmeler:**
- Environment variable'lar 4'e düşürüldü
- PromQL sorguları hem Prometheus hem Victoria Metrics ile uyumlu hale getirildi
- Tüm sorgular `app.js` içine gömüldü
- Label eşleşmeleri düzeltildi (kube-state-metrics v2 `exported_namespace`, `node` label'larını kullanıyor)

### 2. Victoria Metrics Uyumluluğu

**Cluster Yapısı:**
- vmsingle (storage): `vmsingle.moniple.com`
- vmagent (scraper): annotation-based Kubernetes service discovery

**Kurulan Exporter'lar:**
```bash
# kube-state-metrics
helm install kube-state-metrics prometheus-community/kube-state-metrics -n monitoring

# node-exporter (Docker Desktop için hostRootFsMount disabled)
helm install node-exporter prometheus-community/prometheus-node-exporter \
  --namespace monitoring \
  --set hostRootFsMount.enabled=false
```

**Service Annotation Düzeltmesi:**
```bash
kubectl annotate svc -n monitoring node-exporter-prometheus-node-exporter prometheus.io/scrape=true --overwrite
kubectl annotate svc -n monitoring node-exporter-prometheus-node-exporter prometheus.io/port=9100 --overwrite
```

### 3. PromQL Sorguları (Gömülü)

```javascript
const QUERIES = {
  // Namespace
  NS: 'kube_namespace_status_phase{phase="Active"}',

  // PVC
  PVC_USAGE: 'sum by (namespace,persistentvolumeclaim) (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes * 100)',
  PVC_TOTAL: 'sum by (namespace,persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes)',
  PVC_CAPACITY: 'sum by (namespace,persistentvolumeclaim) (kube_persistentvolumeclaim_resource_requests_storage_bytes)',

  // Pod
  POD_STATUS: 'sum by(exported_namespace,pod,phase) (kube_pod_status_phase > 0)',
  POD_CPU_USAGE: 'sum by (pod,namespace) (rate(container_cpu_usage_seconds_total{pod!=""}[5m]))',
  POD_MEMORY_USAGE: 'sum by (pod,namespace) (container_memory_working_set_bytes{pod!=""})',

  // Node
  NODE_INFO_EXPORTER: 'node_uname_info',
  NODE_INFO_KSM: 'kube_node_info',
  NODE_MEMORY_USAGE: '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100',
  NODE_MEMORY_TOTAL: 'sum by (node) (kube_node_status_allocatable{resource="memory"})',
  NODE_DISK_USAGE: 'max by (instance) ((node_filesystem_size_bytes{fstype=~"ext.?|xfs|overlay"} - node_filesystem_avail_bytes{fstype=~"ext.?|xfs|overlay"}) / node_filesystem_size_bytes{fstype=~"ext.?|xfs|overlay"} * 100)',
  NODE_DISK_TOTAL: 'sum by (node) (kube_node_status_allocatable{resource="ephemeral_storage"})',
  NODE_CPU_USAGE: '(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100',
  NODE_CPU_TOTAL: 'sum by (node) (kube_node_status_allocatable{resource="cpu"})',
  NODE_POD_USAGE: 'count by (node) (kube_pod_info) / sum by (node) (kube_node_status_allocatable{resource="pods"}) * 100',
  NODE_POD_TOTAL: 'sum by (node) (kube_node_status_allocatable{resource="pods"})'
};
```

### 4. API Endpoint'leri

| Endpoint | Açıklama | Örnek Response |
|----------|----------|----------------|
| `GET /health` | Health check | `{"ok": true, "timestamp": 1769062375}` |
| `GET /metrics/overview` | Mobil dashboard özeti | cluster, usage, alerts, healthy |
| `GET /metrics/ns` | Namespace listesi | count, namespaces[] |
| `GET /metrics/node` | Node detayları | summary, nodes[] |
| `GET /metrics/pod` | Pod durumları | summary, pods[] |
| `GET /metrics/pvc` | PVC kullanımları | count, pvcs[] |
| `GET /metrics/alerts` | Aktif alertler | summary, alerts[] |

### 5. Environment Variables

```bash
# Zorunlu
PROMETHEUS_API_URL=http://vmsingle.moniple.com/api/v1

# Opsiyonel
PROMETHEUS_API_USER=
PROMETHEUS_API_PASSWORD=
DEFAULT_THRESHOLD=80
PORT=3000
```

---

## Docker Image

```bash
# Build & Push
docker buildx build --platform linux/amd64,linux/arm64 -t muhgumus/moniple-agent:main --push .
```

**Image:** `muhgumus/moniple-agent:main` / `muhgumus/moniple-agent:latest`
**Platforms:** linux/amd64, linux/arm64

---

## Önemli Notlar

### Label Eşleşmeleri (kube-state-metrics v2)
- Namespace: `exported_namespace` (kube-state-metrics) vs `namespace` (cAdvisor)
- Node: `node` label'ı kullanılıyor (`exported_node` değil)
- Pod: `pod` label'ı kullanılıyor (`exported_pod` değil)

### Node Metrikleri Eşleşmesi
- `node_uname_info` → `nodename` ve `instance` (node-exporter IP:port)
- `kube_node_info` → `node` label'ı
- node-exporter metrikleri `instance` ile eşleşiyor
- kube-state-metrics metrikleri `node` ile eşleşiyor

### Docker Desktop Sınırlamaları
- node-exporter için `hostRootFsMount.enabled=false` gerekli
- Disk metrikleri overlay filesystem'de düzgün çalışmayabilir

---

## Test Komutu

```bash
# Local test
PROMETHEUS_API_URL=http://vmsingle.moniple.com/api/v1 node app.js

# Endpoint test
curl http://localhost:3000/metrics/overview | jq '.'
```

---

## Sonraki Adımlar (TODO)

- [ ] Kubernetes Deployment YAML oluştur
- [ ] Cluster'a deploy et
- [ ] Alerting kuralları ekle (vmalert)
- [ ] Grafana dashboard entegrasyonu
