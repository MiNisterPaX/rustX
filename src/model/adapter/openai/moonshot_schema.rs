//! Project closed tool resource graphs into Moonshot's local-reference dialect.
//! Canonical schemas and native execution validators remain unchanged.

use std::collections::HashMap;

use referencing::{Draft, Registry, Resolver, Resource};
use serde_json::{Map, Value, json};

pub(super) fn applies(api_base: &str) -> bool {
    url::Url::parse(api_base).ok().is_some_and(|url| {
        matches!(
            url.host_str(),
            Some("api.kimi.com" | "api.moonshot.cn" | "api.moonshot.ai")
        )
    })
}

pub(super) fn project_tools(request: &mut Value) -> Result<(), String> {
    let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for tool in tools {
        let Some(schema) = tool.pointer_mut("/function/parameters") else {
            continue;
        };
        *schema = project(schema)?;
    }
    Ok(())
}

fn project(schema: &Value) -> Result<Value, String> {
    let resource = Resource::from_contents(schema.clone()).map_err(|e| e.to_string())?;
    let draft = resource.draft();
    let uri = resource.id().unwrap_or("json-schema:///").to_owned();
    // DefaultRetriever refuses missing resources: provider projection does no I/O.
    let registry = Registry::try_new(uri.clone(), resource).map_err(|e| e.to_string())?;
    let resolver = registry.try_resolver(&uri).map_err(|e| e.to_string())?;
    let root = resolver.lookup("").map_err(|e| e.to_string())?;
    let mut projector = Projector {
        keys: HashMap::new(),
        defs: Map::new(),
    };
    let mut output = projector.node(root.contents(), &resolver, draft, 0)?;
    if !projector.defs.is_empty() {
        output["$defs"] = Value::Object(projector.defs);
    }
    Ok(output)
}

struct Projector {
    keys: HashMap<(usize, String, Draft), String>,
    defs: Map<String, Value>,
}

impl Projector {
    fn node(
        &mut self,
        source: &Value,
        parent: &Resolver<'_>,
        inherited: Draft,
        depth: usize,
    ) -> Result<Value, String> {
        if depth > 128 || self.keys.len() > 4096 {
            return Err("Moonshot tool schema exceeds projection bounds".into());
        }
        let draft = inherited.detect(source).map_err(|e| e.to_string())?;
        let resolver = parent
            .in_subresource(draft.create_resource_ref(source))
            .map_err(|e| e.to_string())?;
        if !source.is_object() {
            return Ok(source.clone());
        }
        if source.get("$dynamicRef").is_some() || source.get("$recursiveRef").is_some() {
            return Err(
                "Moonshot tool schema projection does not support dynamic references".into(),
            );
        }
        let mut output = source.clone();
        for key in [
            "$schema",
            "$id",
            "id",
            "$anchor",
            "$dynamicAnchor",
            "$recursiveAnchor",
            "$defs",
            "definitions",
            "x-rustx-schema-nodes",
        ] {
            output.as_object_mut().expect("object checked").remove(key);
        }
        if let Some(reference) = source.get("$ref").and_then(Value::as_str) {
            let resolved = resolver.lookup(reference).map_err(|e| e.to_string())?;
            let (target, target_resolver, target_draft) = resolved.into_inner();
            let key = (
                std::ptr::from_ref(target) as usize,
                target_resolver.base_uri().as_str().to_owned(),
                target_draft,
            );
            let name = if let Some(name) = self.keys.get(&key) {
                name.clone()
            } else {
                let name = format!("schema{}", self.keys.len());
                self.keys.insert(key, name.clone());
                // Reserve before following references, including self-recursion.
                self.defs.insert(name.clone(), json!({}));
                let body = self.node(target, &target_resolver, target_draft, depth + 1)?;
                self.defs.insert(name.clone(), body);
                name
            };
            output["$ref"] = json!(format!("#/$defs/{name}"));
        }
        let children: Vec<_> = draft.subresources_of(source).collect();
        self.children(source, &mut output, &children, &resolver, draft, depth + 1)?;
        // Runtime resource wrappers add no constraints beyond their sole schema.
        // Keep allOf nodes with siblings, which may impose additional constraints.
        if output.as_object().is_some_and(|object| object.len() == 1)
            && let Some(all_of) = output.get_mut("allOf").and_then(Value::as_array_mut)
            && all_of.len() == 1
        {
            return Ok(all_of.pop().expect("single schema checked"));
        }
        Ok(output)
    }

    fn children(
        &mut self,
        source: &Value,
        output: &mut Value,
        schemas: &[&Value],
        resolver: &Resolver<'_>,
        draft: Draft,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 128 {
            return Err("Moonshot tool schema exceeds projection depth".into());
        }
        match (source, output) {
            (Value::Object(input), Value::Object(out)) => {
                for (key, value) in out {
                    if let Some(original) = input.get(key) {
                        self.child(original, value, schemas, resolver, draft, depth)?;
                    }
                }
            }
            (Value::Array(input), Value::Array(out)) => {
                for (original, value) in input.iter().zip(out) {
                    self.child(original, value, schemas, resolver, draft, depth)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn child(
        &mut self,
        source: &Value,
        output: &mut Value,
        schemas: &[&Value],
        resolver: &Resolver<'_>,
        draft: Draft,
        depth: usize,
    ) -> Result<(), String> {
        if schemas.iter().any(|child| std::ptr::eq(*child, source)) {
            *output = self.node(source, resolver, draft, depth + 1)?;
        } else {
            // const/enum/default objects are business data, never schemas.
            self.children(source, output, schemas, resolver, draft, depth + 1)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::identity::ToolId;
    use crate::tools::types::{ToolDefinition, ToolExecutionPolicy, ToolOrigin, ToolReplayPolicy};

    fn compile(schema: Value) -> Value {
        crate::tools::compile_model_definition(&ToolDefinition {
            id: ToolId::new("tool-example"),
            name: "example".into(),
            description: "Example".into(),
            input_schema: schema,
            execution_policy: ToolExecutionPolicy::ModelSelectable,
            replay_policy: ToolReplayPolicy::Never,
            origin: ToolOrigin::Builtin,
        })
        .unwrap()
        .input_schema
    }

    #[test]
    fn local_refs_preserve_recursive_business_and_permission_validation() {
        let original = compile(json!({"type":"object","properties":{
            "path":{"type":"string"},"next":{"$ref":"#"},
            "literal":{"const":{"$ref":"unchanged"}}
        },"required":["path"],"additionalProperties":false}));
        let projected = project(&original).unwrap();
        assert!(
            projected["properties"]["arguments"]["$ref"]
                .as_str()
                .unwrap()
                .starts_with("#/$defs/")
        );
        let before = crate::tools::schema::build_validator(&original).unwrap();
        let after = crate::tools::schema::build_validator(&projected).unwrap();
        for value in [
            json!({"arguments":{"path":"a"},"execution_mode":"foreground"}),
            json!({"arguments":{"path":"a","next":{"path":"b"},"literal":{"$ref":"unchanged"}},"execution_mode":"foreground","elevation_reason":"review"}),
            json!({"arguments":{"path":1},"execution_mode":"foreground"}),
            json!({"arguments":{"path":"a","next":{}},"execution_mode":"foreground"}),
            json!({"arguments":{"path":"a"},"execution_mode":"unexpected"}),
            json!({"arguments":{"path":"a"},"extra":true}),
        ] {
            assert_eq!(before.is_valid(&value), after.is_valid(&value), "{value}");
        }
        assert!(projected.to_string().contains("unchanged"));
        assert!(!projected.to_string().contains("json-schema:///"));
    }

    #[test]
    fn bundled_resources_and_literal_reference_data_are_preserved() {
        let original = compile(json!({"$id":"https://example.test/root","type":"object",
            "properties":{"value":{"$ref":"number"}},"required":["value"],
            "$defs":{"number":{"$id":"number","type":"integer","minimum":2}}
        }));
        let projected = project(&original).unwrap();
        let validator = crate::tools::schema::build_validator(&projected).unwrap();
        assert!(
            validator.is_valid(&json!({"arguments":{"value":3},"execution_mode":"foreground"}))
        );
        assert!(
            !validator.is_valid(&json!({"arguments":{"value":1},"execution_mode":"foreground"}))
        );
    }

    #[test]
    fn sole_all_of_wrappers_flatten_after_references_and_children_are_projected() {
        let original = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$defs":{"value":{"allOf":[{"allOf":[{"type":"integer","minimum":2}]}]}},
            "allOf":[{"type":"object","properties":{"value":{"allOf":[{"$ref":"#/$defs/value"}]}},
                "required":["value"],"additionalProperties":false}]
        });
        let projected = project(&original).unwrap();
        assert_eq!(projected["type"], "object");
        assert_eq!(projected["required"], json!(["value"]));
        assert_eq!(projected["additionalProperties"], false);
        assert_eq!(
            projected["properties"]["value"],
            json!({"$ref":"#/$defs/schema0"})
        );
        assert_eq!(
            projected["$defs"]["schema0"],
            json!({"type":"integer","minimum":2})
        );
        let before = crate::tools::schema::build_validator(&original).unwrap();
        let after = crate::tools::schema::build_validator(&projected).unwrap();
        for value in [
            json!({"value":3}),
            json!({"value":1}),
            json!({}),
            json!({"value":3,"extra":true}),
        ] {
            assert_eq!(before.is_valid(&value), after.is_valid(&value), "{value}");
        }
    }

    #[test]
    fn all_of_siblings_and_literal_business_data_are_preserved() {
        let literal = json!({"allOf":[{"allOf":[{"$ref":"literal-reference"}]}]});
        let original = json!({
            "type":"object",
            "properties":{
                "constrained":{"allOf":[{"type":"integer","minimum":2}],"maximum":4,"description":"Keep siblings"},
                "constant":{"const":literal},
                "choice":{"enum":[literal]},
                "fallback":{"default":literal},
                "multiple":{"allOf":[{"type":"integer"},{"minimum":2}]}
            },
            "required":["constrained"],"additionalProperties":false
        });
        let projected = project(&original).unwrap();
        assert_eq!(projected, original);
        let validator = crate::tools::schema::build_validator(&projected).unwrap();
        assert!(validator.is_valid(&json!({"constrained":3,"constant":literal,"choice":literal})));
        assert!(!validator.is_valid(&json!({"constrained":5})));
        assert!(!validator.is_valid(&json!({"constrained":1})));
    }

    #[test]
    fn every_native_tool_projects_without_mutating_its_contract() {
        let agents = crate::runtime::subagent::AgentCatalog::empty();
        let definitions = crate::tools::native::definitions(
            crate::tools::native::NativeToolPolicies::default(),
            &agents,
        );
        for (definition, _) in definitions {
            let model = crate::tools::compile_model_definition(&definition).unwrap();
            let original = model.input_schema.clone();
            let projected = project(&model.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", model.name));
            assert_eq!(model.input_schema, original);
            crate::tools::schema::build_validator(&projected)
                .unwrap_or_else(|error| panic!("{}: {error}", model.name));
            assert!(
                projected["properties"]["arguments"]["$ref"]
                    .as_str()
                    .unwrap()
                    .starts_with("#/$defs/")
            );
        }
    }

    #[test]
    fn missing_resources_do_not_trigger_io() {
        assert!(project(&json!({"type":"object","properties":{"bad":{"$ref":"http://127.0.0.1:1/not-fetched"}}})).is_err());
    }

    #[test]
    fn host_selection_and_non_tool_payloads_are_bounded() {
        assert!(applies("https://api.kimi.com/coding/v1"));
        assert!(applies("https://api.moonshot.cn/v1"));
        assert!(!applies("https://api.kimi.com.attacker.test/v1"));
        assert!(!applies("https://api.openai.com/v1"));
        let mut payload = json!({"messages":[],"tools":[{"type":"function","function":{"name":"x","parameters":{"type":"object","properties":{"n":{"type":"integer"}}}}}]});
        project_tools(&mut payload).unwrap();
        assert_eq!(payload["tools"][0]["function"]["name"], "x");
        assert_eq!(payload["messages"], json!([]));
    }
}
