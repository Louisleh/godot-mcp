extends Node3D

var health: int = 42
var key_events: int = 0
var cyclic_data: Dictionary = {}


func _ready() -> void:
	cyclic_data["self"] = cyclic_data


func _unhandled_key_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed:
		key_events += 1
