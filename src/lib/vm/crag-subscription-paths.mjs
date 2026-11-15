import path from 'node:path'

export const CRAG_HOST_MOUNT = '/run/kin/crag-host'

export function cragSubscriptionPublicDirectory(projectRoot) {
  return path.resolve(process.env.KIN_DATA_DIR || path.join(projectRoot, 'src', 'data'), 'crag-subscription', 'public')
}
