# task-limiter

This package provides helpers to control the execution of many async/sync functions. You might
use this to limit the number of ongoing HTTP requests at any one time, or perhaps manage batch
processing for many files. There are three classes available:

-	`TaskLimiter`: Limit the number of functions that can be running at any time; additionally,
	it allows you to limit the number of functions queued for execution
- 	`TaskStackAsync`: Built on top of `TaskLimiter`, this lets you run many functions at the same
	time, but listen to the results synchronously. For simple cases, you could instead use
	`Promise.all`
-	`TaskStackSync`: An optimization of `TaskStackAsync` for cases where you want only one function
	to run at a time. Functions are executed in a synchronous, blocking fashion.


[API documentation](https://azmisov.github.io/task-limiter) |
[npm package](https://www.npmjs.com/package/task-limiter) |
[GitHub source code](https://www.github.com/Azmisov/task-limiter)

## Installation

```
npm i task-limiter
```

This project uses ES 2015+ class features. A Babel transpiled and minified version is provided as
`tasklimiter.compat.min.js`, with exports under `TaskLimiter`; though I highly recommend building a
bundle yourself to customize the target and reduce code size. A plain minified version is provided
as `tasklimiter.min.js`.

## Usage

Please see the API documentation linked above for full usage. To import the library:

```js
import { TaskLimiter, TaskStackAsync, TaskStackSync } from "task-limiter";
```

If not using a bundler, you'll need to provide a path to the actual source file, e.g.
`./node_modules/task-limiter/tasklimiter.mjs`.

To use the `TaskLimiter`:

```js
// limit to 5 running tasks, and maximum 20 queued tasks
const tl = new TaskLimiter(5, 20);

// add tasks as your program runs
for (const file of files){
	// blocks until the task can be queued to run;
	// you can add both async and sync functions, and also Promise objects
	await tl.add(process_file.bind(file));
}

// you can also wait before adding a task
await tl.canRun();
tl.add(another_task);

// wait until all tasks finish;
// there are also additional listeners available like queuedLimit or blockedEmpty
await tl.runningEmpty();
```

*As a warning, you can run into deadlock situations if adding tasks recursively.* Check the
`TaskLimiter` API docs for recommendations in this regard.

The `TaskLimiter` provides a secondary queue for tasks to be run. Without a queue, execution blocks
(by awaiting `TaskLimiter.add`) until another task can run. Using a queue, you can instead have a
two-stage pipeline. This can help you get higher throughput, since any time spent creating
additional tasks and enqueueing them can be performed while we wait. The `TaskLimiter` scheduler
will then immediately run the next prepared task.

The `TaskStackAsync` class is built on top of `TaskLimiter`, and provides a way to listen to the
task results in the order they were added.

```js
// pass an ordered listener as the first argument;
// limit to 5 running tasks, and maximum 20 queued tasks
const tsa = new TaskStackAsync((res, id) => {
	// listener is called for each task in the order it was added
	console.log(`Got results for task ${id}: ${res}`);
}, 5, 20);

// you can also manually change the underlying TaskLimiter
tsa.limiter = my_task_limiter;

for (const file of ordered_files)
	await tsa.add(process_file);

// TaskStackAsync only provides an `empty` listener;
// you can use this for task synchronization
await tsa.empty();

// you may also want to access the underlying limiter
await tsa.limeter.runningEmpty();
```

The `TaskStackSync` class behaves the same as `TaskStackAsync`, except there is only one running
task, and the queue is infinite. The class is provided as a lightweight optimization for this case.
Use it when you want to force a set of tasks to run sequentially.

*Warning: Async function and Promise rejections are not caught by these helpers. If they reject, it will
cause the task scheduler to throw an error and your program will crash/misbehave. Make sure to
add rejection handlers in your code.*