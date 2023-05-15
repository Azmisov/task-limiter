import { TaskStackAsync, TaskStackSync } from "./tasklimiter.mjs";

// double checking that there is no stack overflow
if (0){
	const ts = new TaskStackAsync((res, id, ...args) => {
		console.log("finished task", id);
	});

	let tid = 0;
	while (true){
		ts.add(() => {
			tid++;
		});
	}
}

if (1){
	const ts = new TaskStackSync();
	
	let tid = 0;
	while (true){
		ts.add(() => {
			console.log("running task", ++tid);
		});
	}
}