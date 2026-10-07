import { handleBlast } from './lib/handlers'
import { nodeHandler } from './lib/nodeHandler'

export const maxDuration = 30

export default nodeHandler(handleBlast)
