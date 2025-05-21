import { TestFlow, FlowConfig } from '@teamkeel/sdk';

const config: FlowConfig = {
	title: "this is just a test flow!"
};

// To learn more about flows, visit https://docs.keel.so/flows
export default TestFlow(config, async (ctx) => {
	await ctx.ui.page("test page", {
		content: [
			ctx.ui.display.banner({
				title: "test banner",
				description: "test description",
				mode: "info",
			}),
		],
	});
});