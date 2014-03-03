/*!
 * Copyright 2014 mpowers
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
(function(window, undefined) {

	/*
	 * Pollster monitors feeds and notifies subscribers of updates. We expect to
	 * see a number of different strategies for achieving near-real-time
	 * results, and those should be drop in replacements for this interface.
	 */
	var pollster = window.pollster = {};

	/**
	 * Shared timer.
	 */
	var timer;

	/**
	 * Ordered queue of tasks to complete, highest priority at front.
	 */
	var queue = [];

	/**
	 * Shared callback list.
	 */
	var topicToSubscribers = {};

	/**
	 * Mapping of topic to corresponding task.
	 */
	var topicToTask = {};

	/**
	 * Subscribe to have your notify(feedXml, query) method called each time new
	 * results are received for the specified query.
	 */
	pollster.subscribe = function(query, subscriber) {
		var topic = JSON.stringify(query);
		var subscribers = topicToSubscribers[topic];
		if (subscribers) {
			var existing = subscribers.indexOf(subscriber);
			if (existing === -1) {
				subscribers.push(subscriber);
			}
		} else {
			topicToSubscribers[topic] = [ subscriber ];
		}

		// if existing task
		var task = topicToTask[topic];
		if (task) {
			// notify subscriber now of latest results
			if (task.latestResult) {
				subscriber.notify(task.latestResult, query);
			}
			// eliminate delay before next refetch
			task.noFetchBefore = 0;
		} else {
			// otherwise: create new task
			task = {
				query : query,
				lastUpdate : 0,
				lastFetched : 0,
				noFetchBefore : 0
			};
			topicToTask[topic] = task;
			// execute now
			doTask(task);
			// doTask will insert task into queue
		}

	};

	pollster.unsubscribe = function(subscriber) {
		// scan the entire list and remove ourself
		for ( var i in topicToSubscribers) {
			for ( var j in topicToSubscribers[i]) {
				if (topicToSubscribers[i][j] === subscriber) {
					topicToSubscribers[i].splice(j, 1); // remove
					if (topicToSubscribers[i].length === 0) {
						delete topicToSubscribers[i];
					}
				}
			}
		}
	};

	var concurrentFetchCount = 0;

	pollster.getPendingCount = function() {
		return concurrentFetchCount;
	};

	pollster.incrementPendingCount = function() {
		concurrentFetchCount++;
	};

	pollster.decrementPendingCount = function() {
		concurrentFetchCount--;
	};

	/**
	 * Executes the task's query and notifies subscribers. Return true if task
	 * completed successfully, or false if no query was executed.
	 */
	var doTask = function(task) {
		var topic = JSON.stringify(task.query);
		var subscribers = topicToSubscribers[topic];
		if (!subscribers || subscribers.length === 0) {
			console.log("Deleting task: " + topic);
			console.log(task);
			delete topicToSubscribers[topic];
			delete topicToTask[topic];
			return false; // task was not handled
		}
		// console.log("doTask: " + task.toString());
		var query = shallowCopy(task.query);
		var feedId = query.feedId;

		if (task.latestEntryId) {
			// use latest entry update time
			query.after = task.latestEntryId;
		}

		// if first time executing task
		if (task.lastFetched === 0) {
			// fetch only latest few and requeue
			query.count = 3;
		}

		var self = this;
		pollster.incrementPendingCount();
		console.log("concurrentFetchCount: inc:" + concurrentFetchCount);
		console.log("Sent:     " + concurrentFetchCount + " : " + JSON.stringify(query));
		model.pull(query, function(feedData) {
			concurrentFetchCount--;
			console.log("concurrentFetchCount: dec:" + concurrentFetchCount);
			if (!feedData) {
				console.log("Not found: " + concurrentFetchCount + " : " + JSON.stringify(query));
			} else {
				console.log("Received: " + concurrentFetchCount + " : " + JSON.stringify(query));

				// call each subscriber's notify function
				for ( var i in subscribers) {
					subscribers[i].notify(feedData, query);
				}

				// grab the latest result if any
				task.latestResult = feedData;
				var entries = feedData.children("entry");
				if (entries.length > 0) {
					task.latestEntry = entries.first();
					task.latestEntryId = controller.entryIdFromEntryUrn(task.latestEntry.children("id").text());
				}

				// requeue this task
				var now = new Date().getTime();
				var updated;
				var diff;
				if (task.latestEntry) {
					// use latest entry update if we can
					updated = Date.parse(task.latestEntry.find("entry updated").first().text());
					if (!updated) {
						console.log("Error: could not parse entry date: " + Date.parse($(feedData).children("entry updated").text()));
					}
				} else {
					// fall back on feed's updated date
					updated = Date.parse(feedData.children("updated").text());
					if (!updated) {
						console.log("Error: could not parse feed date: " + feedData.children("updated").text());
					}
				}
				if (!updated) {
					console.log("       defaulting to one hour");
					diff = 60 * 60 * 1000; // default to 1 hour
					updated = now - diff;
				}
				diff = now - updated;
				if (diff < 1) {
					console.log("Error: feed was updated in the future: " + updated);
					diff = 60 * 60 * 1000; // default to 1 hour
				}

				if (task.lastFetched === 0) {
					// first time fetch:
					// fetch again asap
					task.noFetchBefore = 0;
					console.log("rescheduled: " + task.query.feedId + " : asap");
				} else {
					// fetch on a sliding delay
					diff = Math.max(6, Math.min(diff, Math.floor(Math.pow(diff / 60000, 1 / 3) * 20000)));
					task.noFetchBefore = now + diff;
					// schedule fetch for cube root of the number of elapsed
					// minutes
					console.log("rescheduled: " + task.query.feedId + " : " + Math.floor((now - updated) / 1000) + "s : " + Math.floor(diff / 1000 / 60) + "m " + Math.floor((diff / 1000) % 60) + "s");
				}
				task.lastUpdate = updated;
				task.lastFetched = now;

				insertTaskIntoSortedQueue(task);
			}
		});
		return true; // task was handled
	};

	var insertTaskIntoSortedQueue = function(task) {
		// console.log("insertTaskIntoSortedQueue: ");
		// console.log(task);
		// could try binary search but suspect
		// reverse linear might be faster with js array:
		var time = task.nextFetch;
		var next;
		for (var i = queue.length - 1; i >= 0; i--) {
			next = queue[i].nextFetch;
			if (next === time) {
				// check for duplicate task
				if (JSON.stringify(queue[i].query) === JSON.stringify(task.query)) {
					console.log("Coalescing duplicate task");
					return; // done: exit
				}
			}
			if (next < time) {
				queue.splice(i + i, 0, task);
				return; // done: exit
			}
		}
		// insert at rear of queue
		queue.splice(0, 0, task);
	};

	/**
	 * Resumes polling.
	 */
	var start = function() {
		if (!timer) {
			timer = window.setInterval(function() {
				onTick();
			}, 1000);
		}
	};

	/**
	 * Pauses polling.
	 */
	var stop = function() {
		window.clearInterval(timer);
	};

	/**
	 * Called with each tick of the timer to refetch any pending feeds on the
	 * queue.
	 */
	var onTick = function() {
		if (concurrentFetchCount < 5) {
			// console.log("onTick");
			var task;
			var time = new Date().getTime();
			for (var i = queue.length - 1; i >= 0; i--) {
				task = queue[i];
				if (task.noFetchBefore < time) {
					queue.splice(i, 1); // remove
					if (doTask(task)) {
						return; // done: exit
					}
				}
			}
		}
	};

	var shallowCopy = function(obj) {
		var result = {};
		for ( var i in obj) {
			result[i] = obj[i];
		}
		return result;
	};

	/**
	 * Called by model to notify us of a local change to a feed so we can
	 * refresh our subscribers if needed.
	 */
	model.subscribe(function(feedId) {
		var copy = [];
		var priority = [];
		var task;
		var i;
		for (i in queue) {
			task = queue[i];
			// catch plain and urn:feed case
			if (feedId.indexOf(task.query.feedId) != -1) {
				// fetch asap
				task.noFetchBefore = 0;
				task.lastUpdate = new Date().getTime();
				priority.push(task);
			} else {
				copy.push(task);
			}
		}
		for (i in priority) {
			copy.push(priority[i]);
		}
		queue = copy;
	});

	/**
	 * Start the timer.
	 */
	start();

})(window);
