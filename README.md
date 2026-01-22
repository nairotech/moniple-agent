# Moniple Agent API

Kubernetes cluster metriklerini mobil uygulamalar için optimize edilmiş JSON formatında sunan REST API.

## Base URL

```
http://<moniple-agent-host>:3000
```

---

## Endpoints

### 1. Health Check

Servisin çalışıp çalışmadığını kontrol eder.

```
GET /health
```

**Response:**
```json
{
  "ok": true,
  "timestamp": 1769062375
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Servis durumu |
| `timestamp` | number | Unix timestamp (saniye) |

---

### 2. Cluster Overview (Dashboard)

Mobil ana ekran için tüm özet bilgileri tek endpoint'te sunar. **Mobil dashboard için önerilen endpoint.**

```
GET /metrics/overview
```

**Response:**
```json
{
  "ok": true,
  "timestamp": 1769062375,
  "cluster": {
    "nodes": 3,
    "pods": {
      "running": 45,
      "total": 50
    }
  },
  "usage": {
    "cpu": {
      "value": 45,
      "unit": "%",
      "critical": false
    },
    "memory": {
      "value": 62,
      "unit": "%",
      "critical": false
    },
    "disk": {
      "value": 35,
      "unit": "%",
      "critical": false
    },
    "pod": {
      "value": 41,
      "unit": "%",
      "critical": false
    }
  },
  "alerts": {
    "total": 2,
    "firing": 1,
    "critical": 0
  },
  "healthy": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `cluster.nodes` | number | Toplam node sayısı |
| `cluster.pods.running` | number | Çalışan pod sayısı |
| `cluster.pods.total` | number | Toplam pod sayısı |
| `usage.cpu.value` | number | Ortalama CPU kullanımı (%) |
| `usage.cpu.critical` | boolean | Threshold aşıldı mı (default: 80%) |
| `usage.memory.value` | number | Ortalama memory kullanımı (%) |
| `usage.disk.value` | number | Ortalama disk kullanımı (%) |
| `usage.pod.value` | number | Pod kapasitesi kullanımı (%) |
| `alerts.total` | number | Toplam alert sayısı |
| `alerts.firing` | number | Aktif alert sayısı |
| `alerts.critical` | number | Critical seviye alert sayısı |
| `healthy` | boolean | Cluster sağlıklı mı (tüm metrikler threshold altında ve critical alert yok) |

**Mobil Kullanım Önerileri:**
- `healthy: false` ise kırmızı uyarı göster
- `usage.*.critical: true` olan metrikleri vurgula
- `alerts.firing > 0` ise badge göster

---

### 3. Namespace List

Cluster'daki tüm namespace'leri listeler.

```
GET /metrics/ns
```

**Response:**
```json
{
  "ok": true,
  "timestamp": 1769062100,
  "count": 26,
  "namespaces": [
    "cert-manager",
    "default",
    "kube-system",
    "monitoring",
    "production",
    "staging"
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | number | Namespace sayısı |
| `namespaces` | string[] | Alfabetik sıralı namespace listesi |

**Mobil Kullanım Önerileri:**
- Namespace seçimi için dropdown/picker olarak kullan
- Pod listesini filtrelemek için kullan

---

### 4. Node Details

Tüm node'ların detaylı kaynak kullanımını gösterir.

```
GET /metrics/node
```

**Response:**
```json
{
  "ok": true,
  "timestamp": 1769062207,
  "summary": {
    "nodeCount": 3,
    "cpu": {
      "usage": 45,
      "total": 24,
      "unit": "%",
      "critical": false
    },
    "memory": {
      "usage": 62,
      "total": 96,
      "unit": "%",
      "critical": false
    },
    "disk": {
      "usage": 35,
      "total": 1500,
      "unit": "%",
      "critical": false
    },
    "pod": {
      "usage": 41,
      "total": 330,
      "unit": "%",
      "critical": false
    }
  },
  "nodes": [
    {
      "name": "node-1",
      "instance": "192.168.1.10:9100",
      "cpu": {
        "usage": 42,
        "total": 8,
        "unit": {
          "usage": "%",
          "total": "cores"
        },
        "critical": false
      },
      "memory": {
        "usage": 58,
        "total": 31.4,
        "unit": {
          "usage": "%",
          "total": "GiB"
        },
        "critical": false
      },
      "disk": {
        "usage": 32,
        "total": 500,
        "unit": {
          "usage": "%",
          "total": "GiB"
        },
        "critical": false
      },
      "pod": {
        "usage": 45,
        "total": 110,
        "unit": {
          "usage": "%",
          "total": "pods"
        },
        "critical": false
      }
    }
  ]
}
```

**Summary Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `summary.nodeCount` | number | Toplam node sayısı |
| `summary.cpu.usage` | number | Ortalama CPU kullanımı (%) |
| `summary.cpu.total` | number | Toplam CPU core sayısı |
| `summary.memory.usage` | number | Ortalama memory kullanımı (%) |
| `summary.memory.total` | number | Toplam memory (GiB olarak gösterilir) |
| `summary.disk.total` | number | Toplam disk (GiB) |
| `summary.pod.total` | number | Toplam pod kapasitesi |

**Node Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `nodes[].name` | string | Node hostname |
| `nodes[].instance` | string | Node IP:port |
| `nodes[].cpu.usage` | number | CPU kullanımı (%) |
| `nodes[].cpu.total` | number | CPU core sayısı |
| `nodes[].memory.usage` | number | Memory kullanımı (%) |
| `nodes[].memory.total` | number | Toplam memory (GiB) |
| `nodes[].disk.usage` | number | Disk kullanımı (%) |
| `nodes[].disk.total` | number | Toplam disk (GiB) |
| `nodes[].pod.usage` | number | Pod kapasitesi kullanımı (%) |
| `nodes[].pod.total` | number | Maksimum pod sayısı |
| `nodes[].*.critical` | boolean | Threshold aşıldı mı |

**Mobil Kullanım Önerileri:**
- Her node için circular progress bar göster
- `critical: true` olan kaynakları kırmızı göster
- Summary'yi üstte, node listesini altta göster

---

### 5. Pod List

Tüm pod'ların durumu ve kaynak kullanımını gösterir.

```
GET /metrics/pod
```

**Response:**
```json
{
  "ok": true,
  "timestamp": 1769062350,
  "summary": {
    "total": 50,
    "running": 45,
    "pending": 3,
    "failed": 2
  },
  "pods": [
    {
      "namespace": "production",
      "name": "api-server-7d96c4d48f-t8rqn",
      "phase": "Running",
      "cpu": {
        "value": 0.125,
        "unit": "cores"
      },
      "memory": {
        "value": 256.5,
        "unit": "MiB"
      }
    },
    {
      "namespace": "production",
      "name": "worker-5ff79b64d4-2cgzl",
      "phase": "Running",
      "cpu": {
        "value": 0.05,
        "unit": "cores"
      },
      "memory": {
        "value": 128.3,
        "unit": "MiB"
      }
    },
    {
      "namespace": "staging",
      "name": "test-pod-abc123",
      "phase": "Pending",
      "cpu": {
        "value": 0,
        "unit": "cores"
      },
      "memory": {
        "value": 0,
        "unit": "bytes"
      }
    }
  ]
}
```

**Summary Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `summary.total` | number | Toplam pod sayısı |
| `summary.running` | number | Running durumundaki pod sayısı |
| `summary.pending` | number | Pending durumundaki pod sayısı |
| `summary.failed` | number | Failed durumundaki pod sayısı |

**Pod Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `pods[].namespace` | string | Pod'un namespace'i |
| `pods[].name` | string | Pod adı |
| `pods[].phase` | string | Pod durumu: `Running`, `Pending`, `Failed`, `Succeeded`, `Unknown` |
| `pods[].cpu.value` | number | CPU kullanımı (cores cinsinden, örn: 0.125 = 125 millicores) |
| `pods[].cpu.unit` | string | Her zaman `"cores"` |
| `pods[].memory.value` | number | Memory kullanımı |
| `pods[].memory.unit` | string | `"bytes"`, `"KiB"`, `"MiB"`, `"GiB"` |

**Mobil Kullanım Önerileri:**
- Summary'yi üstte pill/badge olarak göster (Running: 45, Pending: 3, Failed: 2)
- Failed pod'ları kırmızı, Pending pod'ları sarı göster
- Namespace'e göre grupla veya filtrele
- Pod adı uzunsa ellipsis (...) kullan
- CPU değerini millicores olarak göster: `0.125 cores` → `125m`

**CPU Dönüşümü (millicores):**
```
millicores = cpu.value * 1000
Örnek: 0.125 cores = 125m
```

---

### 6. PVC List

PersistentVolumeClaim'lerin kapasitesi ve kullanımını gösterir.

```
GET /metrics/pvc
```

**Response:**
```json
{
  "ok": true,
  "timestamp": 1769062218,
  "count": 5,
  "pvcs": [
    {
      "namespace": "monitoring",
      "name": "prometheus-data",
      "total": {
        "value": 100,
        "unit": "GiB"
      },
      "usage": {
        "value": 45,
        "unit": "%"
      },
      "critical": false
    },
    {
      "namespace": "production",
      "name": "postgres-data",
      "total": {
        "value": 500,
        "unit": "GiB"
      },
      "usage": {
        "value": 82,
        "unit": "%"
      },
      "critical": true
    },
    {
      "namespace": "staging",
      "name": "redis-data",
      "total": {
        "value": 10,
        "unit": "GiB"
      },
      "usage": {
        "value": "N/A",
        "unit": ""
      },
      "critical": false
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `count` | number | Toplam PVC sayısı |
| `pvcs[].namespace` | string | PVC'nin namespace'i |
| `pvcs[].name` | string | PVC adı |
| `pvcs[].total.value` | number | Toplam kapasite |
| `pvcs[].total.unit` | string | `"bytes"`, `"KiB"`, `"MiB"`, `"GiB"`, `"TiB"` |
| `pvcs[].usage.value` | number \| string | Kullanım yüzdesi veya `"N/A"` (veri yoksa) |
| `pvcs[].usage.unit` | string | `"%"` veya `""` (N/A için) |
| `pvcs[].critical` | boolean | Threshold aşıldı mı (default: 80%) |

**Mobil Kullanım Önerileri:**
- Progress bar ile kullanımı göster
- `critical: true` olanları kırmızı göster
- `usage.value === "N/A"` ise gri/disabled göster

---

### 7. Alerts

Aktif alert'leri listeler.

```
GET /metrics/alerts
```

**Response:**
```json
{
  "ok": true,
  "timestamp": 1769062400,
  "summary": {
    "total": 5,
    "firing": 2,
    "pending": 3,
    "critical": 1,
    "warning": 4
  },
  "alerts": [
    {
      "name": "HighMemoryUsage",
      "severity": "critical",
      "state": "firing",
      "namespace": "production",
      "summary": "Memory usage is above 90% on node-2",
      "activeAt": "2026-01-22T08:30:00Z"
    },
    {
      "name": "PodCrashLooping",
      "severity": "warning",
      "state": "firing",
      "namespace": "staging",
      "summary": "Pod test-pod-abc123 is crash looping",
      "activeAt": "2026-01-22T09:15:00Z"
    },
    {
      "name": "DiskSpaceLow",
      "severity": "warning",
      "state": "pending",
      "namespace": "",
      "summary": "Disk space is below 20% on node-1",
      "activeAt": "2026-01-22T09:45:00Z"
    }
  ]
}
```

**Summary Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `summary.total` | number | Toplam alert sayısı |
| `summary.firing` | number | Aktif (firing) alert sayısı |
| `summary.pending` | number | Bekleyen alert sayısı |
| `summary.critical` | number | Critical seviye alert sayısı |
| `summary.warning` | number | Warning seviye alert sayısı |

**Alert Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `alerts[].name` | string | Alert adı |
| `alerts[].severity` | string | `"critical"`, `"warning"`, `"info"` |
| `alerts[].state` | string | `"firing"`, `"pending"` |
| `alerts[].namespace` | string | İlgili namespace (boş olabilir) |
| `alerts[].summary` | string | Alert açıklaması |
| `alerts[].activeAt` | string | Alert başlangıç zamanı (ISO 8601) |

**Mobil Kullanım Önerileri:**
- Critical alert'leri en üstte ve kırmızı göster
- Firing alert'leri vurgula, pending olanları soluk göster
- Summary'yi üstte badge olarak göster
- `activeAt` zamanını "5 dakika önce" formatında göster

---

## Error Response

Tüm endpoint'ler hata durumunda aynı formatta response döner:

```json
{
  "ok": false,
  "error": "Error message here"
}
```

**HTTP Status Codes:**
- `200` - Başarılı
- `500` - Internal Server Error

---

## Data Types

### Byte Units
Memory ve disk değerleri otomatik olarak uygun birime dönüştürülür:
- `bytes` - < 1 KiB
- `KiB` - < 1 MiB
- `MiB` - < 1 GiB
- `GiB` - < 1 TiB
- `TiB` - >= 1 TiB

### Timestamp
Tüm timestamp'ler Unix epoch formatında (saniye) döner.

### Percentage
Yüzde değerleri 0-100 arasında integer olarak döner.

---

## Mobile App Architecture Recommendations

### Recommended Screens

1. **Dashboard Screen**
   - Endpoint: `GET /metrics/overview`
   - Cluster health status (healthy badge)
   - 4 circular progress bars (CPU, Memory, Disk, Pod)
   - Alert count badge
   - Quick stats (nodes, running pods)

2. **Nodes Screen**
   - Endpoint: `GET /metrics/node`
   - Summary cards at top
   - List of nodes with resource bars
   - Tap node for details

3. **Pods Screen**
   - Endpoint: `GET /metrics/pod` + `GET /metrics/ns`
   - Filter by namespace (dropdown)
   - Search by pod name
   - Color coded by phase
   - Pull to refresh

4. **Storage Screen**
   - Endpoint: `GET /metrics/pvc`
   - List of PVCs with usage bars
   - Critical PVCs highlighted

5. **Alerts Screen**
   - Endpoint: `GET /metrics/alerts`
   - Grouped by severity
   - Firing alerts at top
   - Tap for details

### Refresh Strategy
- Dashboard: Auto refresh every 30 seconds
- Detail screens: Pull to refresh
- Alerts: Push notification support (future)

### Offline Support
- Cache last successful response
- Show stale data indicator
- Retry on network restore

---

## Example: Flutter/Dart Model Classes

```dart
class ClusterOverview {
  final bool ok;
  final int timestamp;
  final ClusterInfo cluster;
  final UsageMetrics usage;
  final AlertSummary alerts;
  final bool healthy;

  ClusterOverview.fromJson(Map<String, dynamic> json)
      : ok = json['ok'],
        timestamp = json['timestamp'],
        cluster = ClusterInfo.fromJson(json['cluster']),
        usage = UsageMetrics.fromJson(json['usage']),
        alerts = AlertSummary.fromJson(json['alerts']),
        healthy = json['healthy'];
}

class UsageMetric {
  final int value;
  final String unit;
  final bool critical;

  UsageMetric.fromJson(Map<String, dynamic> json)
      : value = json['value'],
        unit = json['unit'],
        critical = json['critical'];
}

class Pod {
  final String namespace;
  final String name;
  final String phase;
  final ResourceValue cpu;
  final ResourceValue memory;

  Pod.fromJson(Map<String, dynamic> json)
      : namespace = json['namespace'],
        name = json['name'],
        phase = json['phase'],
        cpu = ResourceValue.fromJson(json['cpu']),
        memory = ResourceValue.fromJson(json['memory']);

  Color get phaseColor {
    switch (phase) {
      case 'Running': return Colors.green;
      case 'Pending': return Colors.orange;
      case 'Failed': return Colors.red;
      default: return Colors.grey;
    }
  }

  String get cpuMillicores => '${(cpu.value * 1000).round()}m';
}
```

---

## Example: React Native Fetch

```javascript
const API_BASE = 'http://moniple-agent:3000';

async function fetchOverview() {
  const response = await fetch(`${API_BASE}/metrics/overview`);
  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.error);
  }

  return data;
}

// Usage with React Query
const { data, isLoading, refetch } = useQuery(
  'overview',
  fetchOverview,
  { refetchInterval: 30000 }
);
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROMETHEUS_API_URL` | Yes | `http://prometheus:9090/api/v1` | Prometheus veya Victoria Metrics API URL |
| `PROMETHEUS_API_USER` | No | - | Basic auth username |
| `PROMETHEUS_API_PASSWORD` | No | - | Basic auth password |
| `DEFAULT_THRESHOLD` | No | `80` | Critical threshold (%) |
| `PORT` | No | `3000` | Server port |

### Supported Backends
- Prometheus
- Victoria Metrics (vmsingle, vmselect)
- Thanos Query
- Cortex

---

## Docker

```bash
docker pull muhgumus/moniple-agent:latest

docker run -d \
  -p 3000:3000 \
  -e PROMETHEUS_API_URL=http://prometheus:9090/api/v1 \
  muhgumus/moniple-agent:latest
```

---

## License

MIT
