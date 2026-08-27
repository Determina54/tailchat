import { regGroupPanel } from '@capital/common';
import { Loadable } from '@capital/component';

const PLUGIN_ID = 'com.music.multiplay';

regGroupPanel({
	name: `${PLUGIN_ID}/musicroom`,
	label: 'Music Room',
	provider: PLUGIN_ID,
	render: Loadable(() => import('./group/MusicRoomPanel')),
});
