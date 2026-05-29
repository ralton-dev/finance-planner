{{- define "fp.fullname" -}}
{{- printf "%s" .Release.Name -}}
{{- end -}}

{{- define "fp.labels" -}}
app.kubernetes.io/part-of: finance-planner
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
