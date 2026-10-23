import { translateHostText } from './messages.js';
/** Only for host-generated diagnostic reports. Never pass model/tool/source bodies. */
export const localizeHostReport = (text: string): string => text.split('\n').map(translateHostText).join('\n');
