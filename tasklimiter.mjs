// Helper classes for queueing a batch of promises

function positive_int(name, val, min=0){
	if (!(Number.isInteger(val) && val >= min || val === Infinity))
		throw name+" must be a number >= "+min;
}
const _task_limiter_counts = ["running","queued","blocked","tasks"];

/** Limits the number of Promises that are running, and optionally queued as well.
 *
 * ```js
 * const tl = new TaskLimiter(1,2);
 * 
 * // preferred usage
 * await tl.add(some_function);
 * // you can leave off the await if the queued_limit is Infinity (the default), or to avoid race conditions
 * 
 * // not recommended, but allowed
 * tl.add(already_running_promise);
 * 
 * // more manual control; works as well, but only if the `add` call is sync;
 * // will still need to await tl.add if you want to know when it was queued
 * await tl.tasksBelow(6)
 * tl.add(some_function);
 * // some additional wrappers available for the xxxBelow methods
 * tl.runningEmpty().then(() => {
 * 	process.exit();
 * })
 * ```
 * 
 * After {@link TaskLimiter#add} is called, a task goes through four phases. A phase will be skipped
 * if it can proceed directly to the next:
 * 
 * 1.   The tasks is blocked until it can be added to the queue. You can have multiple tasks blocked
 *      at the same time for use cases like multithreading or uncoordinated code sections, but in
 *      general you should not add more tasks until the previous has unblocked.
 * 2.	Once the number of queued tasks falls below {@link TaskLimiter#queued_limit}, the task
 * 		is moved from blocked to queued.
 * 3. 	Once the number of running tasks falls below {@link TaskLimiter#running_limit}, the task
 * 		is moved from queued to running. If the tasks is a function, it is called here
 * 4. 	The task finishes, possibly asynchronously, and is removed from running
 * 
 * How does queueing tasks recursively work? Take `TaskLimiter(1, 0)` for example: if the running
 * task tries to add another task it could get deadlocked. Here's how to handle recursive tasks:
 * 
 * 1.   If the child is running in-place of the parent task, meaning the parent blocks while waiting
 *      for the child to finish, you do not need to use the TaskLimiter for the child. Just run the
 *      child function/promise directly in the parent.
 * 2.   If for whatever reason the child does need to use the TaskLimiter, for example multiple
 *      children running simultaneously, or you want to limit the total parent+child recursion, you
 *      can run into deadlock scenarios. The easiest way to prevent this is to increment
 *      {@link TaskLimiter#running_limit} before doing your child tasks, and then decrement when
 *      done. For tail recursion scenarios, where the parent would immediately exit when the
 *      children have been queued, you can use `await add(task, true)`; if your tail recursion could
 *      run into recursion stack limit issues, this could be a good alternative to #1.
 */
export class TaskLimiter{
	/** Create a new task limiter
	 * @param {number} [running_limit=10] Initial value for {@link TaskLimiter#running_limit} property
	 * @param {number} [queued_limit=Infinity] Initial value for {@link TaskLimiter#queued_limit} property
	 */
	constructor(running_limit=10, queued_limit=Infinity){
		positive_int("running limit", running_limit, 1);
		positive_int("queued limit", queued_limit);
		/** Private storage for {@link TaskLimiter#running_limit}
		 * @private
		 */
		this._running_limit = running_limit;
		/** Private storage for {@link TaskLimiter#queued_limit}
		 * @private
		 */
		this._queued_limit = queued_limit;
		/** Set of promises waiting to be resolved... the async tasks
		 * @type {Set<Promise>}
		 * @private
		 */
		this.tasks_running = new Set();
		/** These tasks are waiting to be run;each entry a function that generates a promise (async
		 * task) or something else (sync task)
		 * @type {Array<function|Promise>}
		 * @private
		 */ 
		this.tasks_queued = [];
		/** Blocked tasks; if this grows too large it means you are not awaiting promise from `add`.
		 * Each entry a tuple [fn, resolver]; `fn` is moved to `tasks_queued` once resolved
		 * @type {Array.<function[]>}
		 * @private
		 */
		this.tasks_blocked = [];
		/** Whether we are shifting tasks to different queues (_shift_tasks method). It is
		 * incremented/decremented for each recursive shift call
		 * @type {number}
		 * @private
		 */
		this.shifting = 0;
		/** Listeners for when running/queued/blocked/tasks counts go below a threshold:
		 * `{[type]: Map(limit => [[lid, resolver_fn], ...])}`
		 *	
		 * I chose this structure since I assume the number of unique `limit` values will be very
		 * small. Better to just loop through all limits than have the cost of maintaining sorted
		 * structure.
		 *	
		 * Out of all limiters[type][limit][0] candidates that meet our dirty check criteria, we
		 * resolve in order of lid, so that promises are resolved in the order of creation. Could
		 * use a heap, but think its overkill: with avg 2 candidates per check, faster to just brute
		 * force look for the min.
		 * @type {Object<string, Map<number, Array>>}
		 * @private
		 */
		this.listeners = {};
		for (const t of _task_limiter_counts)
			this.listeners[t] = new Map();
		
		this.lid = 0;
	}
	/** Limits the number of async tasks that can be running at the same time. If you
	 *  - add a Promise directly to `add` method
	 *  - dynamically change this value
	 * 
	 * then the running task count could rise above this limit temporarily.
	 * @type {number}
	 */
	get running_limit(){ return this._running_limit; }
	/** Limits the number of tasks that can be queued. {@link TaskLimiter#add} will block until the
	 * queue opens up more slots. If you dynamically change this value, the queued task count could
	 * rise above this limit temporarily.
	 * 
	 * Set this to `Infinity` for unlimited queue, and no blocked tasks. If not `Infinity`, make
	 * sure you await the {@link TaskLimiter#add} result, otherwise an internal `tasks_blocked`
	 * list will be filled. This can be zero to have no queue, blocking until a task can be run.
	 * @type {number}
	 */
	get queued_limit(){ return this._queued_limit; }
	set running_limit(limit){
		if (limit == this._running_limit)
			return
		positive_int("running limit", limit, 1);
		let more_slots = this._running_limit > limit;
		this._running_limit = limit;
		if (more_slots)
			this._shift_tasks();
	}
	set queued_limit(limit){
		if (limit == this._queued_limit)
			return
		positive_int("queued limit", limit);
		let more_slots = this._queued_limit > limit;
		this._queued_limit = limit;
		if (more_slots)
			this._shift_tasks();
	}

	/** Number of running tasks
	 * @readonly
	 * @type {number}
	 */
	get running(){ return this.tasks_running.size; }
	/** Number of queued tasks
	 * @readonly
	 * @type {number}
	 */
	get queued(){ return this.tasks_queued.length; }
	/** Number of blocked tasks that have yet to be queued
	 * @readonly
	 * @type {number}
	 */
	get blocked(){ return this.tasks_blocked.length; }
	/** Number of tasks, either running and queued
	 * @readonly
	 * @type {number}
	 */
	get tasks(){ return this.running + this.queued; }

	/** Internal method used to register xxxBelow listeners
	 * @param limit when the count of "type" falls below this limit, the listener is resolved
	 * @param type one of the vlaues from _task_limiter_counts
	 * @returns {Promise} 
	 * @private
	 */
	_add_listener(limit, type){
		if (limit !== null)
			positive_int(type+" limit", limit, 1);
		const listener = new Promise((resolve) => {
			// register the listener
			const t = this.listeners[type];
			// we fire listeners in order they are registered
			let queue = t.get(limit);
			if (!queue){
				queue = [];
				t.set(limit, queue);
			}
			queue.push([++this.uid, resolve]);
		});
		// in case we are not shifting already, do so now;
		// shift_tasks triggers listeners once all tasks have been shifted into their correct lists
		this._shift_tasks();
		return listener;
	}
	/**
	 * Returns a promise which resolves when a task can be run. This is an alias for
	 * `runningBelow(null)` call.
	 * @see {@link TaskLimiter#runningBelow}
	 * @returns {Promise}
	 */
	canRun(){ return this.runningBelow(); }
	/**
	 * Returns a promise which resolves when a task can be queued. This is an alias for
	 * `queuedBelow(null)` call.
	 * @see {@link TaskLimiter#queuedBelow}
	 * @returns {Promise}
	 */
	canQueue(){ return this.queuedBelow(); }
	/**
	 * Returns a promise which resolves when a task can be queued or run. See
	 * {@link TaskLimiter#canRun} and {@link TaskLimiter#canQueue} methods. This is an alias for
	 * `tasksBelow(null)` call.
	 * @see {@link TaskLimiter#tasksBelow}
	 * @returns {Promise}
	 */
	canHandle(){ return this.tasksBelow(); }

	/**
	 * Marks a promise `task` as running
	 * @private
	 */
	_async_task(task){
		this.tasks_running.add(task);
		task.catch((err) => {
			console.error("TaskLimiter async task failed:", err);
			// TODO: figure out how to catch this in outer scopes, instead of just killing process
			process.exit(3);
		}).finally(() => {
			this.tasks_running.delete(task);
			this._shift_tasks();
		});
	}
	/**
	 * Substitutes `null` for the current limit; used in listeners
	 * @private
	 */
	_null_limits(type){
		switch (type){
			case "running":
				return this.running_limit;
			case "queued":
				return this.queued_limit;
			case "tasks":
				return this.running_limit + this.queued_limit;
			case "blocked":
				return 1;
		}
	}
	/** Shifts tasks from blocked -> queued -> running if possible, respecting the running/queued
	 * limits.
	 * @private
	 */
	_shift_tasks(){
		// avoid recursive calls; this method has an implicit write lock on the tasks_xxx arrays;
		// so only want one method running at a time or it gets complicated
		if (this.shifting++)
			return;
		// we have this outer loop in case the `listeners` add more tasks / modify limits
		outer: while (true){
			// can run more tasks?
			while (this.running < this._running_limit){
				let fn;
				// run a queued task
				if (this.queued)
					fn = this.tasks_queued.shift();
				// unblock, skipping the queue and running directly
				else if (this.blocked){
					const block = this.tasks_blocked.shift();
					fn = block[0];
					// resolver for `add` promise
					block[1]();
				}
				else break;
				// start the task
				const task = fn();
				if (task instanceof Promise)
					this._async_task(task);
			}
			// no more remaining `running` slots; fill in `queued` slots
			while (this.queued < this._queued_limit && this.blocked){
				const [fn, resolve] = this.tasks_blocked.shift();
				this.tasks_queued.push(fn);
				// resolver for `add` promise
				resolve();
			}

			/* Evaluate listeners;

				TODO: This could be more efficient, making use of extra information we know about, like which
					task_xxx lengths stayed the same, decremented, or incremented. Only need to add/remove entries
					of the heap in specific cases. Thinking we could pass a flag with extra information about such
					things to _shift_tasks, or perhaps just a bitset on the class that gets disjuncted
			*/
			// use prev_shifting to track if the listener resolvers do some recursive action that requires further shifting
			let prev_shifting = this.shifting;
			// initialize heap-like structure (we won't actually heapify), for evaluating listeners promises in order;
			// each entry a triplet [type, limit, [[lid, resolver], ...]]
			let heap = [];
			const heap_filter = (t, l) => {
				// substitute null limits with actual values
				const lval = l === null ? this._null_limits(t) : l;
				return this[t] < lval;
			};
			for (const t in this.listeners){
				for (const [l,q] of this.listeners[t]){
					if (heap_filter(t, l))
						heap.push([t, l, q]);
				}
			}
			while (heap.length){
				// heap peek
				let min = 0;
				for (let i=1; i<heap.length; i++)
					if (heap[i][2][0] < heap[min][2][0])
						min = heap[i];
				const [t, l, q] = heap[min];
				const head = q.shift();
				// resolve listener
				head[1]();
				// no more listeners for this type+limit?
				if (!q.length){
					this.listeners[t].delete(l);
					heap.splice(min, 1);
				}
				/* if prev_shifting different, listener triggered further shifting either
						a) running/queued limit incremented, or
						b) new blocked tasks
					we double check if shifts are needed; note we need to re-shift immediately, so that, for example, we don't trigger
					multiple "canQueue" resolvers when only one can be queued
				*/
				if (prev_shifting != this.shifting && (this.queued < this._queued_limit && this.blocked || this.running < this._running_limit && this.queued))
					continue outer;
				/* trim out heap values that don't meet limit criteria anymore; since we restart with the prev_shifting cases,
					this will only happen when:
						a) running/queued limit decreased, or
						b) running async new tasks
				*/
				for (let i=0; i<heap.length; ){
					const [ti, li, qi] = heap[i];
					if (!heap_filter(ti, li))
						heap.splice(i,1);
					else i++;
				}
			}
			break;
		}
		this.shifting = 0;
	}
	/** Add a task to be queued
	 * @param {Promise | function} task This can be a promise, in which case it is considered
	 *  running already. Otherwise it should be a function representing a task. If the function
	 *  returns a promise, it is considered an async task and will handled accordingly; if it
	 *  returns any other type, it is assumed to be a synchronous task.
	 * @param {boolean} nonblocking If true, for a task that is not yet running this will send it
	 *  directly to the queue, disregarding any {@link TaskLimiter#queued_limit}. You might use this
	 *  if you add tasks in a tail recursive manner, knowing that a running slot will open up and
	 *  bring the queued length back to queued_limit.
	 * @returns {Promise} resolves when the task is queued or run immediately
	 */
	add(task, nonblocking=false){
		// already running; we just add it as running task
		if (task instanceof Promise){
			this._async_task(task);
			return Promise.resolve();
		}
		if (nonblocking){
			this.tasks_queued.push(task);
			this._shift_tasks();
			return Promise.resolve();
		}
		// otherwise it starts out blocked; _shift_tasks handles queueing/running it
		return new Promise((resolve) => {
			this.tasks_blocked.push([task, resolve]);
			this._shift_tasks();
		});
	}
}
// Add methods for [type]Below listeners
for (const t of _task_limiter_counts){
	TaskLimiter.prototype[t+"Below"] = function(limit=null){
		return this._add_listener(limit, t);
	};
	TaskLimiter.prototype[t+"Empty"] = function(){
		return this._add_listener(1, t);
	};
}
/** Returns promise that resolves when {@link TaskLimiter#running} falls below `limit`
 * @function 
 * @name runningBelow
 * @memberof TaskLimiter.prototype
 * @param {?number} [limit=null] null checks if it is below {@link TaskLimiter#running_limit}
 * @returns {Promise}
 */
/** Returns promise that resolves when {@link TaskLimiter#queued} falls below `limit`
 * @function
 * @name queuedBelow
 * @memberof TaskLimiter.prototype
 * @param {number?} [limit=null] null checks if it is below {@link TaskLimiter#queued_limit}
 * @returns {Promise}
 */
/** Returns promise that resolves when {@link TaskLimiter#blocked} falls below `limit`
 * @function
 * @name blockedBelow
 * @memberof TaskLimiter.prototype
 * @param {number?} [limit=null] null checks if it is below one (e.g. no blocked tasks)
 * @returns {Promise}
 */
/** Returns promise that resolves when {@link TaskLimiter#tasks} falls below `limit`
 * @function
 * @name tasksBelow
 * @memberof TaskLimiter.prototype
 * @param {number?} [limit=null] null checks if it is below the sum of 
 *  {@link TaskLimiter#running_limit} and {@link TaskLimiter#queued_limit}
 * @returns {Promise}
 */

/** Returns promise that resolves when there are no running tasks
 * @function
 * @name runningEmpty
 * @memberof TaskLimiter.prototype
 * @returns {Promise}
 */
/** Returns promise that resolves when there are no queued tasks
 * @function
 * @name queuedEmpty
 * @memberof TaskLimiter.prototype
 * @returns {Promise}
 */
/** Returns promise that resolves when there are no blocked tasks
 * @function
 * @name blockedEmpty
 * @memberof TaskLimiter.prototype
 * @returns {Promise}
 */
/** Returns promise that resolves when there are no running or queued tasks
 * @function
 * @name tasksEmpty
 * @memberof TaskLimiter.prototype
 * @returns {Promise}
 */

/** Listener called with ordered task results
 * @callback StackListener
 * @param {any} res return value of the `num`-th aded task
 * @param {number} num zero-indexed number indicating the order this task was queued
 * @param {...any} args forwarded arguments that were passed when the task was added
 */

/** Used to run many sync/async functions simultaneously, but return results in the order they were
 * added. This utilizes {@link TaskLimiter} internally to limit the number of executed tasks. An
 * example use case might be the need to read/preprocess many files, but needing to aggregate the
 * results in order.
 */
export class TaskStackAsync{
	/** Create a new TaskStackAsync
	 * @param {!Stacklistener} listener listener for task results
	 * @param {number} [running_limit=16] number of tasks that can be running at a time (e.g.
	 * 	{@link TaskLimiter#running_limit})
	 * @param {number} [queued_limit=Infinity] number of tasks that can be queued at a time (e.g.
	 * 	{@link TaskLimiter#queued_limit})
	 */
	constructor(listener, running_limit=16, queued_limit=Infinity){
		/** Buffered results that need to be ordered. Maps the task `num` to listener callback arguments
		 * @type {Map<number, any[]>}
		 * @private
		 */
		this.results = new Map();
		/** Number of tasks that have been added
		 * @type {number}
		 * @private
		 */
		this.count = 0;
		/** Current task number we're waiting on to complete
		 * @type {number}
		 * @private
		 */
		this.current = 0;
		/** Listener for results
		 * @type {!StackListener}
		 */
		this.listener = listener;
		/** Limiter for simultaneous running tasks
		 * @type {TaskLimiter}
		 */
		this.limiter = new TaskLimiter(running_limit, queued_limit);
		/** Resolvers for when queue is empty
		 * @type {function[]}
		 * @private
		 */
		this.done_listeners = [];
	}
	/** Add an ordered task to the stack
	 * @param {Promise | function} task Running promise or function
	 * 	(if promise is already running, the limit config option may not be respected)
	 * @param {...any} args Arguments to pass to the {@link TaskStackAsync#listener} (not the task!)
	 * @returns {Promise} a promise resolving when the underlying {@link TaskLimiter} unblocks
	 */
	async add(task, ...args){
		let qtask, num = this.count;
		// already running promise
		if (task instanceof Promise)
			qtask = this._add_cbk(task, num, args);
		else{
			qtask = () => {
				const res = task(); // returns sync result or a promise
				return this._add_cbk(res, num, args);
			}
		}
		this.count++;
		return this.limiter.add(qtask);
	}
	/** Adds callback for a task's completion (supports both sync or async task)
	 * @param {Promise | any} task the result of running a task; a Promise indicates an async result
	 * @param {number} num task index
	 * @param {any[]} args arguments to be passed to the listener
	 * @private
	 */
	_add_cbk(task, num, args){
		const complete_handler = (res) => {
			args.unshift(res, num);
			this.results.set(num, args);
			// remove from buffer
			while (this.results.has(this.current)){
				this.listener(...this.results.get(this.current));
				this.results.delete(this.current);
				this.current++;
			}
			// done promise resolver
			if (this.current == this.count){
				for (let l of this.done_listeners)
					l();
				this.done_listeners = [];
			}
		};
		// async (promise that resolves a result)
		if (task instanceof Promise)
			task.then(complete_handler);
		// sync (result)
		else complete_handler(task);
		return task;
	}
	/** Returns promise which resolves when stack is empty
	 * @returns {Promise}
	 */
	empty(){
		if (this.current == this.count)
			return Promise.resolve();
		return new Promise((resolve) => {
			this.done_listeners.push(resolve);
		});
	}
}

/** Used to run many sync/async functions sequentially. Only one task is run at a time, so the
 * results do not need to be buffered and ordered. Also to keep the class simple, there is no queue
 * limit imposed. This is equivalent to either {@link TaskStackAsync} or {@link TaskLimiter} with
 * `running_limit = 1` and `queued_limit = Infinity`. For full control, you can use those
 * alternatives.
 * 
 * Note that while this runs tasks "synchronously" all tasks are converted to async functions, as
 * tasks may not be run immediately, instead queued in the stack.
 */
export class TaskStackSync{
	/** Create a new `TaskStackSync`
	 * @param {?StackListener} [listener=null] listener for task results; optional for this class,
	 * 	since you can be guaranteed tasks are run sequentially
	 */
	constructor(listener=null){
		/** Listener for results
		 * @type {?StackListener}
		 */
		this.listener = listener;
		/** Functions/promises that are queued
		 * @type {Promise[]}
		 * @private
		 */
		this.queue = [];
		/** Listeners that are called when the stack empties
		 * @type {function[]}
		 * @private
		 */
		this.done_listeners = [];
		/** Count for task unique id's
		 * @type {number}
		 * @private
		 */
		this.count = 0;
	}
	/** Adds another task to be run
	 * @param {function|Promise} task
	 * @param {...any} args arguments to pass to the {@link TaskStackSync#listener} (not the task!)
	*/
	add(task, ...args){
		const id = this.count++;
		const qtask = async () => {
			let res;
			if (task instanceof Promise)
				res = await task;
			else{
				res = task();
				if (res instanceof Promise)
					res = await res;
			}
			if (this.listener)
				this.listener(res, id, ...args);
			this.queue.shift();
			// next task
			if (this.queue.length)
				this.queue[0]();
			else{
				for (let l of this.done_listeners)
					l();
				this.done_listeners = [];
			}
		}
		if (this.queue.length)
			this.queue.push(qtask);
		else qtask();
	}
	/** Returns promise which resolves when stack is empty
	 * @returns {Promise}
	 */
	empty(){
		if (!this.queue.length)
			return Promise.resolve();
		return new Promise((resolve) => {
			this.done_listeners.push(resolve);
		});
	}
}