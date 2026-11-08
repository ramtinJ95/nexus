import { test } from "node:test";
import assert from "node:assert/strict";
import { directory, instanceFiles, scratchDirectory, stagingDirectory, stateFiles, stateRootOf, tombstoneDirectory } from "./instance-layout.ts";

// The names are on disk in every existing pylon, so a change here strands them.
test("every state and instance file keeps the name it had on disk", () => {
	const root = "/state";
	const { kind, ...files } = stateFiles(root);
	assert.deepEqual(files, { scratch: "/state/tmp", hostBridge: "/state/host-bridge.sock" });
	assert.equal(kind("instances"), "/state/instances");
	assert.equal(kind("templates"), "/state/templates");
	assert.equal(directory(root, "instances", "p1"), "/state/instances/p1");
	assert.equal(stagingDirectory(root, "templates", "t1"), "/state/templates/.t1.creating");
	assert.equal(tombstoneDirectory(root, "instances", "p1"), "/state/instances/.p1.deleting");
	assert.equal(stateRootOf("/state/instances/p1"), root);
	assert.equal(scratchDirectory(root, "/state/instances/p1"), "/state/tmp/d8cbee5bc82e");
	assert.deepEqual(instanceFiles("/state/instances/p1"), {
		record: "/state/instances/p1/record.json",
		intent: "/state/instances/p1/intent.json",
		status: "/state/instances/p1/status.json",
		disk: "/state/instances/p1/disk.qcow2",
		nextDisk: "/state/instances/p1/disk.next.qcow2",
		log: "/state/instances/p1/controller.log",
		pid: "/state/instances/p1/controller.pid",
		socket: "/state/instances/p1/control.sock",
		launchLock: "/state/instances/p1/launch.lock",
		retryStop: "/state/instances/p1/retry-stop.json",
		services: "/state/instances/p1/services.json",
		adHoc: "/state/instances/p1/adhoc.json",
		linked: "/state/instances/p1/linked.json",
		checkpoint: "/state/instances/p1/nexus-checkpoint.json",
	});
});
