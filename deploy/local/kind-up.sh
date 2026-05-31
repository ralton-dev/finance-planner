#!/usr/bin/env bash
# Build images, load them into a local kind cluster, and helm install.
# Requires: docker, kind, kubectl, helm.
set -euo pipefail

CLUSTER="${CLUSTER:-finance-planner}"
REGISTRY="ghcr.io/ralton-dev/finance-planner"
TAG="dev"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! kind get clusters | grep -q "^${CLUSTER}$"; then
  echo "Creating kind cluster '${CLUSTER}'..."
  kind create cluster --name "${CLUSTER}"
fi

for svc in web api auth calc; do
  echo "Building ${svc}..."
  docker build -t "${REGISTRY}/${svc}:${TAG}" -f "${REPO_ROOT}/apps/${svc}/Dockerfile" "${REPO_ROOT}"
  kind load docker-image "${REGISTRY}/${svc}:${TAG}" --name "${CLUSTER}"
done

helm upgrade --install finance-planner "${REPO_ROOT}/deploy/helm/finance-planner" \
  --set image.tag="${TAG}" \
  --set image.pullPolicy=IfNotPresent

echo "Done. Try: kubectl get pods"
