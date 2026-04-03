import { Nav } from '@fluentui/react';
import { View } from '../../layout/layout';

export const WelcomeView = () => {
	return (
		<View title='Pragma Tools'>
			<Nav
				groups={[
					{
						links: [
							{ name: 'Pragma Standup (Redmond)', url: 'https://vscode-standup.azurewebsites.net', icon: 'JoinOnlineMeeting', target: '_blank' },
							{ name: 'Pragma Standup (Zurich)', url: 'https://stand.azurewebsites.net/', icon: 'JoinOnlineMeeting', target: '_blank' },
							{ name: 'Pragma Errors', url: 'https://errors.code.visualstudio.com', icon: 'ErrorBadge', target: '_blank' },
						]
					}
				]}>
			</Nav>
		</View>
	);
}
