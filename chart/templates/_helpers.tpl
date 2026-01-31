{{/*
Expand the name of the chart.
*/}}
{{- define "moniple-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "moniple-agent.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "moniple-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "moniple-agent.labels" -}}
helm.sh/chart: {{ include "moniple-agent.chart" . }}
{{ include "moniple-agent.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "moniple-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "moniple-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "moniple-agent.serviceAccountName" -}}
{{- default (include "moniple-agent.fullname" .) .Values.serviceAccount.name }}
{{- end }}

{{/*
Get the Prometheus API URL
Auto-configures to local vmsingle if victoria-metrics is enabled and no URL is provided
*/}}
{{- define "moniple-agent.prometheusApiUrl" -}}
{{- if .Values.config.prometheusApiUrl }}
{{- .Values.config.prometheusApiUrl }}
{{- else if index .Values "victoria-metrics" "enabled" }}
{{- printf "http://%s-vmsingle-server:8428/api/v1" .Release.Name }}
{{- else }}
{{- "http://vmsingle.moniple.svc:8428/api/v1" }}
{{- end }}
{{- end }}

{{/*
Get the Victoria Metrics Single server URL for vmagent remote write
*/}}
{{- define "moniple-agent.vmRemoteWriteUrl" -}}
{{- printf "http://%s-vmsingle-server:8428/api/v1/write" .Release.Name }}
{{- end }}
