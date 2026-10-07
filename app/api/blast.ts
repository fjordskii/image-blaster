import { handleBlast } from './_lib/handlers.js'
import { nodeHandler } from './_lib/nodeHandler.js'

export const maxDuration = 30

export default nodeHandler(handleBlast)
